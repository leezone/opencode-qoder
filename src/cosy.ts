import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { QODER_CLIENT_TYPE, QODER_VERSION, type QoderRegion, stateFiles } from "./constants.js";
import { legacyOpencodeDataFile, opencodeDataFile } from "./json-store.js";

const qoderRSAPublicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

const QoderDataPolicy = "disagree";
const QoderLoginVersion = "v2";
const QoderMachineOS = "x86_64_windows";
const QoderMachineTypeMagic = "5";

interface UserInfo {
  uid: string;
  security_oauth_token: string;
  name: string;
  aid: string;
  email: string;
}

interface CosyPayload {
  version: string;
  requestId: string;
  info: string;
  cosyVersion: string;
  ideVersion: string;
}

export interface CosyCredentials {
  userID: string;
  authToken: string;
  name: string;
  email: string;
  machineID?: string;
}

function rsaEncryptBase64(data: Buffer | string): string {
  const encrypted = crypto.publicEncrypt(
    {
      key: qoderRSAPublicKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    typeof data === "string" ? Buffer.from(data) : data,
  );
  return encrypted.toString("base64");
}

function aesEncryptCBCBase64(plaintext: string, keyStr: string): string {
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(keyStr), Buffer.from(keyStr));
  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");
  return encrypted;
}

function computeSigPath(urlStr: string): string {
  const parsed = new URL(urlStr);
  let sigPath = parsed.pathname;
  if (sigPath.startsWith("/algo")) sigPath = sigPath.substring("/algo".length);
  return sigPath;
}

// Locations a machine id may live in, most authoritative first:
//
//   1. qodercli's own file. If the user has the CLI installed, its id wins, so
//      the plugin and the CLI sign as the same machine.
//   2. this plugin's id under opencode's data directory -- XDG_DATA_HOME-aware,
//      the same rule opencode applies to the directory it writes auth.json into.
//   3. the path from before the data directory honoured XDG_DATA_HOME, read
//      only. The id is a signing input, so a user who set the variable after
//      the file was written keeps their existing id instead of churning to a
//      fresh one; nothing is ever written here.
//
// A miss on all three falls through to a new id, persisted at (2).
function machineIdCandidates(region: QoderRegion = "global"): {
  read: string[];
  write: string;
} {
  const filename = stateFiles(region).machineId;
  // qodercli's own machine id is only a fallback for the international region:
  // it belongs to the Qoder CLI install, which signs against the international
  // site. Letting a CN instance adopt it would make both deployments see one
  // machine identity, which is exactly what the per-region file prevents.
  const cliFile = join(homedir(), ".qoder", ".auth", "machine_id");
  const file = opencodeDataFile(filename);
  const read = region === "cn" ? [file] : [cliFile, file, legacyOpencodeDataFile(filename)];
  return { read: read.filter((path, i) => read.indexOf(path) === i), write: file };
}

export function getMachineId(region: QoderRegion = "global"): string {
  const { read, write } = machineIdCandidates(region);

  for (const path of read) {
    if (!existsSync(path)) continue;
    try {
      const val = readFileSync(path, "utf8").trim();
      if (val) return val;
    } catch {}
  }

  const newId = crypto.randomUUID();
  try {
    mkdirSync(dirname(write), { recursive: true });
    writeFileSync(write, newId, "utf8");
  } catch {}
  return newId;
}

export function buildAuthHeaders(
  body: Buffer | string | null,
  requestURL: string,
  creds: CosyCredentials,
  region: QoderRegion = "global",
): Record<string, string> {
  if (!creds.userID) throw new Error("qoder: user id is empty");
  if (!creds.authToken) throw new Error("qoder: auth token is empty");

  const aesKey = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const userInfo: UserInfo = {
    uid: creds.userID,
    security_oauth_token: creds.authToken,
    name: creds.name || "",
    aid: "",
    email: creds.email || "",
  };

  const infoB64 = aesEncryptCBCBase64(JSON.stringify(userInfo), aesKey);
  const cosyKey = rsaEncryptBase64(aesKey);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const requestId = crypto.randomUUID();

  const cosyPayload: CosyPayload = {
    version: "v1",
    requestId,
    info: infoB64,
    cosyVersion: QODER_VERSION,
    ideVersion: "",
  };

  const payloadB64 = Buffer.from(JSON.stringify(cosyPayload)).toString("base64");
  const sigPath = computeSigPath(requestURL);
  const bodyStr = body ? (Buffer.isBuffer(body) ? body.toString("utf8") : body) : "";
  const sigInput = `${payloadB64}\n${cosyKey}\n${timestamp}\n${bodyStr}\n${sigPath}`;
  const sig = crypto.createHash("md5").update(sigInput).digest("hex");
  const bodyHash = crypto
    .createHash("md5")
    .update(body || "")
    .digest("hex");
  const bodyLen = body
    ? (Buffer.isBuffer(body) ? body.length : Buffer.from(body).length).toString()
    : "0";
  const machineID = creds.machineID || getMachineId(region);

  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "Cosy-Key": cosyKey,
    "Cosy-User": creds.userID,
    "Cosy-Date": timestamp,
    "Cosy-Version": QODER_VERSION,
    "Cosy-Machineid": machineID,
    "Cosy-Machinetoken": machineID,
    "Cosy-Machinetype": QoderMachineTypeMagic,
    "Cosy-Machineos": QoderMachineOS,
    "Cosy-Clienttype": QODER_CLIENT_TYPE,
    "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": bodyHash,
    "Cosy-Bodylength": bodyLen,
    "Cosy-Sigpath": sigPath,
    "Cosy-Data-Policy": QoderDataPolicy,
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": QoderLoginVersion,
    "X-Request-Id": crypto.randomUUID(),
  };
}

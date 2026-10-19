import { resolveQoderCredentials } from './dist/auth.js';
import { resolveEndpoints } from './dist/constants.js';

const creds = await resolveQoderCredentials({ region: 'global' });
const endpoints = resolveEndpoints('global');

console.log('Testing with minimal headers (like plugin)...');
const res1 = await fetch(endpoints.campaigns, {
  headers: {
    'Accept': 'application/json',
    'Authorization': `Bearer ${creds.access}`
  }
});
const data1 = await res1.json();
console.log('Minimal headers result:', JSON.stringify(data1, null, 2));

console.log('\n\nTesting with full Cosy headers (like qodercli)...');
const machineId = creds.machineID;
const res2 = await fetch(endpoints.campaigns, {
  headers: {
    'Accept': 'application/json',
    'Authorization': `Bearer ${creds.access}`,
    'Cosy-Version': '1.1.42',
    'Cosy-ClientType': '5',
    'Cosy-MachineId': machineId,
    'Cosy-Machinetoken': machineId,
    'Cosy-Machinetype': '5',
    'Cosy-Machineos': 'x86_64_linux',
  }
});
const data2 = await res2.json();
console.log('Full headers result:', JSON.stringify(data2, null, 2));

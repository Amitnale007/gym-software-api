
import dotenv from 'dotenv';
import { spawnSync } from 'node:child_process';

dotenv.config();
    // "deploy": "aws lambda-web deploy --name aws-web-demo --code . --profile amit-aws --region us-east-1",
const requiredVariables = [
  'MONGODB_URI',
  'GEMINI_API_KEY',
];

for (const key of requiredVariables) {
  if (!process.env[key]) {
    console.error(`Missing ${key} in .env`);
    process.exit(1);
  }
}
  
const args = [
  'lambda-web',
  'deploy',
  '--name', 'gym-api',
  '--code', '.',
  '--profile', 'amit-aws',
  '--region', 'us-east-1',
];

const variablesToDeploy = [
  'MONGODB_URI',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
];

for (const key of variablesToDeploy) {
  if (process.env[key]) {
    args.push('--env', `${key}=${process.env[key]}`);
  }
}

console.log('Deploying gym-api with .env configuration...');

const result = spawnSync('aws', args, {
  stdio: 'inherit',
  shell: false,
});

if (result.error) {
  console.error('Deployment failed:', result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);

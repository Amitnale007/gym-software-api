import 'dotenv/config';
import mongoose from 'mongoose';
import dbConnect from '../config/dbConnect.js';
import User from '../models/userModel.js';
import seedSuperadmin from '../services/seedSuperadmin.js';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

async function readCredentials() {
  if (!process.stdin.isTTY) {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    return JSON.parse(input);
  }

  let hideInput = false;
  const output = new Writable({ write(chunk, encoding, callback) {
    if (!hideInput) process.stdout.write(chunk, encoding);
    callback();
  } });
  const prompt = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const name = (await prompt.question('Superadmin name [Superadmin]: ')).trim() || 'Superadmin';
    const email = await prompt.question('Superadmin email: ');
    process.stdout.write('Superadmin password (at least 8 characters, hidden): ');
    hideInput = true;
    const password = await prompt.question('');
    process.stdout.write('\n');
    return { name, email, password };
  } finally { prompt.close(); }
}

try {
  const credentials = await readCredentials();
  await dbConnect();
  await User.init();
  await seedSuperadmin(credentials);
  console.log('Superadmin account is saved in MongoDB. Existing passwords are preserved.');
} catch (error) {
  console.error('Superadmin setup failed:', error.message);
  process.exitCode = 1;
} finally { await mongoose.disconnect(); }

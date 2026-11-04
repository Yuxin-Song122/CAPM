import { createECDH, randomBytes } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

const subject = process.argv[2];
if (!subject || !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(subject)) {
  console.error('用法：npm run generate-secrets -- mailto:你的真实邮箱');
  process.exit(1);
}
const pair = createECDH('prime256v1');
pair.generateKeys();
const secrets = {
  PAIRING_SECRET: randomBytes(32).toString('base64url'),
  VAPID_PUBLIC_KEY: pair.getPublicKey().toString('base64url'),
  // ECDH.getPrivateKey() can omit leading zero octets. VAPID encodes the
  // fixed-width 32-byte P-256 scalar, including those zeros.
  VAPID_PRIVATE_KEY: Buffer.concat([Buffer.alloc(32), pair.getPrivateKey()]).subarray(-32).toString('base64url'),
  VAPID_SUBJECT: subject,
};
const target = resolve('.secrets.json');
// wx refuses to overwrite existing keys: changing VAPID keys invalidates the
// corresponding subscriptions, so generating them must be a deliberate action.
await writeFile(target, `${JSON.stringify(secrets, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
try {
  await writeFile(resolve('.dev.vars'), Object.entries(secrets).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
} catch (error) {
  await unlink(target);
  throw error;
}
console.log('已生成本地 .secrets.json 和 .dev.vars，未在终端输出口令或私钥。请妥善保管，勿上传到 GitHub。');

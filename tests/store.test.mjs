import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore, defaultDataDir } from '../server/store.mjs';
import { createExamples } from '../src/model.js';

const sample = () => createExamples('2026-11-04');
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xuri-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, store: await createStore(dir) };
}
test('Windows 默认保存到 D:\\datejob，其他平台目录与代码分开', () => {
  assert.equal(defaultDataDir('win32', '/unused'), 'D:\\datejob');
  assert.equal(defaultDataDir('linux', '/workspace/CAPM'), '/workspace/datejob');
});
test('实际写入 JSON 文件，新存储实例可读取全部项目与完成状态', async (t) => {
  const { dir, store } = await fixture(t);
  assert.equal((await store.read()).state, null);
  const saved = await store.write(sample(), 'missing');
  assert.deepEqual(JSON.parse(await fs.readFile(store.filename, 'utf8')), sample());
  const reopened = await createStore(dir);
  assert.deepEqual(await reopened.read(), saved);
});
test('第二次保存保留上一版本，文件更新后无临时文件或写入锁', async (t) => {
  const { dir, store } = await fixture(t);
  const old = sample();
  const first = await store.write(old, 'missing');
  const next = sample(); next.items[0].completed = false;
  const saved = await store.write(next, first.revision);
  assert.notEqual(saved.revision, first.revision);
  assert.deepEqual(JSON.parse(await fs.readFile(store.backupPath, 'utf8')), old);
  assert.deepEqual((await store.read()).state, next);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['data.json', 'data.previous.json']);
});
test('过期页面不能覆盖新数据，冲突响应带最新版本供界面同步', async (t) => {
  const { store } = await fixture(t);
  const first = await store.write(sample(), 'missing');
  const next = sample(); next.projects[0].name = '已更新的项目';
  const current = await store.write(next, first.revision);
  await assert.rejects(store.write(sample(), first.revision), (error) => error.status === 409 && error.current.revision === current.revision);
  assert.deepEqual((await store.read()).state, next);
});
test('同时发出的两个保存仅允许一个使用旧版本成功', async (t) => {
  const { store } = await fixture(t);
  const first = await store.write(sample(), 'missing');
  const a = sample(); a.items[0].title = '修改 A';
  const b = sample(); b.items[0].title = '修改 B';
  const race = await Promise.allSettled([store.write(a, first.revision), store.write(b, first.revision)]);
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(race.find((r) => r.status === 'rejected').reason.status, 409);
});
test('非法数据和损坏文件不会覆盖原记录', async (t) => {
  const { store } = await fixture(t);
  const saved = await store.write(sample(), 'missing');
  const bad = sample(); bad.items[0].end = '00:00';
  await assert.rejects(store.write(bad, saved.revision), (error) => error.status === 400);
  assert.deepEqual((await store.read()).state, sample());
  await fs.writeFile(store.filename, '{broken');
  await assert.rejects(store.read(), /无法解析/);
  await assert.rejects(store.write(sample(), saved.revision), /无法解析/);
  assert.equal(await fs.readFile(store.filename, 'utf8'), '{broken');
});
test('备份目录不可写入时，原数据保持不变且不报告保存成功', async (t) => {
  const { dir, store } = await fixture(t);
  const saved = await store.write(sample(), 'missing');
  await fs.mkdir(store.backupPath);
  const next = sample(); next.items = [];
  await assert.rejects(store.write(next, saved.revision), /本次修改未保存/);
  assert.deepEqual((await store.read()).state, sample());
  assert.equal((await fs.readdir(dir)).some((name) => name.endsWith('.tmp') || name === '.write.lock'), false);
});
test('外部手动修改数据文件后，旧版本保存仍会被拒绝', async (t) => {
  const { store } = await fixture(t);
  const saved = await store.write(sample(), 'missing');
  const external = sample(); external.projects[0].name = '文件中的新名称';
  await fs.writeFile(store.filename, JSON.stringify(external));
  await assert.rejects(store.write(sample(), saved.revision), (error) => error.status === 409);
  assert.equal((await store.read()).state.projects[0].name, '文件中的新名称');
});
test('无目录写入权限时明确报错，文件不变', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('POSIX 权限测试'); return; }
  const { dir, store } = await fixture(t);
  const saved = await store.write(sample(), 'missing');
  await fs.chmod(dir, 0o500);
  try {
    await assert.rejects(store.write(sample(), saved.revision), /本次修改未保存/);
    assert.deepEqual((await store.read()).state, sample());
  } finally { await fs.chmod(dir, 0o700); }
});

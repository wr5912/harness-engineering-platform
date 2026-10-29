import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('Docker 引导复用已有安装，缺少资源或非 root 时在写入系统前停止', () => {
  const root = mkdtempSync(join(tmpdir(), 'hep-docker-bootstrap-'))
  const script = new URL('../bootstrap-docker.sh', import.meta.url).pathname
  const bin = join(root, 'bin'), log = join(root, 'commands')
  mkdirSync(bin)
  const write = (name, value) => writeFileSync(join(bin, name), '#!/bin/sh\n' + value, { mode: 0o755 })
  const execute = () => spawnSync('/bin/bash', [script, join(root, 'missing-resources')], {
    env: { ...process.env, PATH: bin, HEP_TEST_LOG: log }, encoding: 'utf8',
  })
  try {
    write('id', 'echo 0\n')
    write('systemctl', 'echo "systemctl $*" >> "$HEP_TEST_LOG"\n')
    let result = execute()
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Docker 离线资源应包含/)
    write('docker', 'echo "docker $*" >> "$HEP_TEST_LOG"\n')
    result = execute()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(log, 'utf8'), 'docker compose version\nsystemctl enable --now docker\ndocker version --format {{.Server.Version}} {{.Server.Arch}}\ndocker compose version\n')
    write('id', 'echo 1000\n')
    result = execute()
    assert.equal(result.status, 2)
    assert.match(result.stderr, /需要 root/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('已有 Engine 缺少 Compose 时只补插件，不重装 Engine 或覆盖服务', () => {
  const root = mkdtempSync(join(tmpdir(), 'hep-compose-bootstrap-'))
  const bin = join(root, 'bin'), resources = join(root, 'resources'), log = join(root, 'commands'), marker = join(root, 'installed')
  mkdirSync(bin); mkdirSync(resources)
  const shell = (path, value) => writeFileSync(path, '#!/bin/sh\n' + value, { mode: 0o755 })
  shell(join(bin, 'id'), 'echo 0\n')
  shell(join(bin, 'systemctl'), 'echo "systemctl $*" >> "$HEP_TEST_LOG"\n')
  shell(join(bin, 'docker'), 'echo "docker $*" >> "$HEP_TEST_LOG"\nif [ "$1" = compose ] && [ ! -f "$HEP_TEST_MARKER" ]; then exit 1; fi\n')
  shell(join(bin, 'install'), 'echo "install $*" >> "$HEP_TEST_LOG"\n: > "$HEP_TEST_MARKER"\n')
  const execute = () => spawnSync('/bin/bash', [new URL('../bootstrap-docker.sh', import.meta.url).pathname, resources], {
    env: { ...process.env, PATH: bin, HEP_TEST_LOG: log, HEP_TEST_MARKER: marker }, encoding: 'utf8',
  })
  try {
    let result = execute()
    assert.equal(result.status, 2)
    assert.match(result.stderr, /缺少 Compose/)
    shell(join(resources, 'docker-compose'), 'echo "compose-resource $*" >> "$HEP_TEST_LOG"\n')
    result = execute()
    assert.equal(result.status, 0, result.stderr)
    const calls = readFileSync(log, 'utf8')
    assert.match(calls, /compose-resource version/)
    assert.match(calls, /install -D -m 0755 .*docker-compose \/usr\/local\/lib\/docker\/cli-plugins\/docker-compose/)
    assert.doesNotMatch(calls, /daemon-reload|dockerd|tar|docker-.*tgz/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

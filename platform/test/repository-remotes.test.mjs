import assert from 'node:assert/strict'
import test from 'node:test'
import { repositoryIdentity, sameRepositorySource, transportCandidates } from '../repository-remotes.mjs'

const gitlab = 'http://172.16.138.233/ai-soc/business-agents.git'
const github = 'git@github.com:wr5912/business-agents.git'
const ipv4 = (address, internal = false) => ({ address, internal, family: 'IPv4' })

test('真实 172.16 IPv4 网卡优先 GitLab，其他主机优先 GitHub', () => {
  assert.deepEqual(transportCandidates(gitlab, { eth0: [ipv4('172.16.138.228')] }), [gitlab, github])
  assert.deepEqual(transportCandidates(github, { enp1s0: [{ ...ipv4('172.16.1.2'), family: 4 }] }), [gitlab, github])
  assert.deepEqual(transportCandidates(github, { br0: [ipv4('172.16.1.2')] }), [gitlab, github])
  for (const interfaces of [{}, { eth0: [ipv4('192.168.1.2')] }, { eth0: [ipv4('172.160.1.2')] }, { lo: [ipv4('172.16.1.2', true)] }, { eth0: [{ ...ipv4('172.16.1.2'), family: 'IPv6' }] }]) {
    assert.deepEqual(transportCandidates(gitlab, interfaces), [github, gitlab])
  }
})

test('容器及虚拟桥的 172.16 地址不改变首选来源', () => {
  for (const name of ['docker0', 'veth73ab', 'br-73ab', 'cni0', 'virbr0', 'lxcbr0', 'lxdbr0', 'podman0', 'flannel.1', 'cali1234', 'kube-ipvs0']) {
    assert.deepEqual(transportCandidates(gitlab, { [name]: [ipv4('172.16.0.1')] }), [github, gitlab], name)
  }
  assert.deepEqual(transportCandidates(gitlab, { docker0: [ipv4('172.16.0.1')], eth0: [ipv4('172.16.138.228')] }), [gitlab, github])
})

test('只有指定的 business 镜像可互换，自定义来源及带参数凭据的 URL 保持原样', () => {
  assert.equal(sameRepositorySource(gitlab, github), true)
  assert.equal(sameRepositorySource(gitlab, 'https://github.com/wr5912/business-agents.git'), true)
  assert.equal(repositoryIdentity(github), repositoryIdentity('ssh://git@github.com/wr5912/business-agents.git'))
  for (const url of ['/tmp/business-agents.git', 'file:///tmp/business-agents.git', 'git@github.com:other/business-agents.git', 'http://172.16.138.233/other/business-agents.git', `${gitlab}?token=fixture`, `${gitlab}#main`, 'http://user@172.16.138.233/ai-soc/business-agents.git']) {
    assert.deepEqual(transportCandidates(url, { eth0: [ipv4('172.16.138.228')] }), [url])
    assert.equal(sameRepositorySource(url, github), false)
  }
})

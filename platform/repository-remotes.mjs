import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'

const businessMirrors = [
  'http://172.16.138.233/ai-soc/business-agents.git',
  'git@github.com:wr5912/business-agents.git',
]

export function repositoryIdentity(url) {
  return url.replace(/^git@([^:]+):/, 'https://$1/').replace(/^ssh:\/\/git@/, 'https://').replace(/\.git\/?$/, '').replace(/\/$/, '')
}

const mirrorIdentities = new Set(businessMirrors.map(repositoryIdentity))
const isBusinessMirror = url => mirrorIdentities.has(repositoryIdentity(url))

export function sameRepositorySource(left, right) {
  return repositoryIdentity(left) === repositoryIdentity(right) || isBusinessMirror(left) && isBusinessMirror(right)
}

export function transportCandidates(url, interfaces = networkInterfaces()) {
  if (!isBusinessMirror(url)) return [url]
  const localNetwork = Object.entries(interfaces).some(([name, addresses]) =>
    !/^(?:lo\d*$|docker|veth|br-|cni|virbr|lxcbr|lxdbr|podman|flannel|cali|kube)/i.test(name)
    && (addresses ?? []).some(address => !address.internal && (address.family === 'IPv4' || address.family === 4)
      && isIPv4(address.address) && address.address.startsWith('172.16.')))
  return localNetwork ? [...businessMirrors] : [...businessMirrors].reverse()
}

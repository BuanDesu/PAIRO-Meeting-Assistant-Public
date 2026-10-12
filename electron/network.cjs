const { isIP } = require('node:net');

function rankAddress({ interface: name, ip }) {
  let rank = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? 20 : 0;
  if (/wi-?fi|wlan|wireless|无线/i.test(name)) rank += 20;
  else if (/ethernet|以太网|本地连接/i.test(name)) rank += 10;
  if (/vpn|tun|tap|virtual|vethernet|wsl|vmware|docker|hyper-v|clash|utun/i.test(name) || ip.startsWith('198.18.')) rank -= 100;
  return rank;
}

function lanAddresses(interfaces, port) {
  const addresses = [];
  for (const [name, records] of Object.entries(interfaces)) {
    for (const record of records || []) {
      if (isIP(record.address) !== 4 || record.internal || /^(127\.|169\.254\.)/.test(record.address)) continue;
      addresses.push({ interface: name, ip: record.address, url: `http://${record.address}:${port}` });
    }
  }
  return addresses.sort((a, b) => rankAddress(b) - rankAddress(a) || a.interface.localeCompare(b.interface) || a.ip.localeCompare(b.ip));
}
module.exports = { lanAddresses };

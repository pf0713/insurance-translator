/**
 * 自动检测本机局域网 IP 并写入配置文件
 * 每次运行 start.bat 时自动更新
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'utils', 'config.js');
const PORT = 8765;

// 找出本机局域网 IP
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        // 优先 192.168 或 10. 或 172. 开头的地址
        if (iface.address.match(/^(192\.168|10\.|172\.)/)) {
          return iface.address;
        }
      }
    }
  }
  return '127.0.0.1';
}

const ip = getLocalIP();
const api = `http://${ip}:${PORT}`;

const config = `// 后端地址（自动检测局域网IP，每次启动更新）
const API = '${api}';
module.exports = { API };
`;
fs.writeFileSync(CONFIG_PATH, config, 'utf-8');

console.log(`\n========================================`);
console.log(`  后端已就绪`);
console.log(`  局域网地址: ${api}`);
console.log(`  已写入: utils/config.js`);
console.log(`  确保手机和电脑在同一 WiFi`);
console.log(`========================================\n`);

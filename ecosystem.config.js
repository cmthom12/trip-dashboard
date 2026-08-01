// PM2 process config. Start with:  pm2 start ecosystem.config.js
// Reload after a deploy with:        pm2 reload ecosystem.config.js
module.exports = {
  apps: [{
    name: 'trip-dashboard',
    script: 'server.js',
    cwd: '/var/www/trip-dashboard',     // <-- match APP_DIR on your server
    env: { PORT: 3000, NODE_ENV: 'production' },
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '300M',
    // data.db lives in cwd and must never be deleted on restart — PM2 doesn't touch it.
  }]
};

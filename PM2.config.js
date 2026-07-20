module.exports = {
  apps: [{
    name: 'polymarket-bot',
    script: './src/index.ts',
    interpreter: 'node',
    interpreter_args: '--loader ts-node/esm --experimental-specifier-resolution=node',
    env: {
      NODE_ENV: 'production',
    },
    watch: false,
    max_memory_restart: '512M',
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: '10s',
    error_file: './logs/error.log',
    out_file: './logs/output.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
  }],
};

module.exports = {
  apps: [
    {
      name: "kpi-portal",
      script: "server.js",
      cwd: "/home/br188/kpi-portal",
      instances: 1,
      exec_mode: "fork",
      env: {
        PORT: "3005"
      }
    }
  ]
};
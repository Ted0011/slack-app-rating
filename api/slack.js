const { createServer } = require('http');
const { createNodeMiddleware } = require('@slack/bolt');
const app = require('../app'); // We'll create this file next

const server = createServer(createNodeMiddleware(app));

module.exports = server;

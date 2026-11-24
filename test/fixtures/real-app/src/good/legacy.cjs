const path = require('node:path');
const { readFileSync } = require('fs');
const _ = require('lodash');
const { Command } = require('commander');

module.exports = { join: (a) => path.join(a, _.trim(' x ')), read: readFileSync, Command };

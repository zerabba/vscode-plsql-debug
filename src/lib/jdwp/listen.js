'use strict';

const net = require('net');
const path = require('path');
const cp = require('child_process');
const JDWPConnection = require('./connection');
const VirtualMachine = require('./virtual_machine');


exports.listen = async (port) => {
  return new Promise((resolve, reject) => {
    const server = net.createServer({
      pauseOnConnect: true,
    }, socket => {
      const vm = new VirtualMachine(new JDWPConnection({ socket }));
      server.close();
      resolve(vm);
    });
      server.listen(port);
  });
};

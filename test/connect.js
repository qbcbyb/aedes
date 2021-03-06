'use strict'

const { test } = require('tap')
const http = require('http')
const ws = require('websocket-stream')
const mqtt = require('mqtt')
const mqttPacket = require('mqtt-packet')
const net = require('net')
const proxyProtocol = require('proxy-protocol-js')
const { protocolDecoder } = require('aedes-protocol-decoder')
const { setup, connect, delay } = require('./helper')
const aedes = require('../')

;[{ ver: 3, id: 'MQIsdp' }, { ver: 4, id: 'MQTT' }].forEach(function (ele) {
  test('connect and connack (minimal)', function (t) {
    t.plan(1)

    const s = setup()
    t.tearDown(s.broker.close.bind(s.broker))

    s.inStream.write({
      cmd: 'connect',
      protocolId: ele.id,
      protocolVersion: ele.ver,
      clean: true,
      clientId: 'my-client',
      keepalive: 0
    })

    s.outStream.on('data', function (packet) {
      t.deepEqual(packet, {
        cmd: 'connack',
        returnCode: 0,
        length: 2,
        qos: 0,
        retain: false,
        dup: false,
        topic: null,
        payload: null,
        sessionPresent: false
      }, 'successful connack')
    })
  })
})

// [MQTT-3.1.2-2]
test('reject client requested for unacceptable protocol version', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQIsdp',
    protocolVersion: 5,
    clean: true,
    clientId: 'my-client',
    keepalive: 0
  })
  s.outStream.on('data', function (packet) {
    t.equal(packet.cmd, 'connack')
    t.equal(packet.returnCode, 1, 'unacceptable protocol version')
    t.equal(broker.connectedClients, 0)
  })
  broker.on('clientError', function (client, err) {
    t.fail('should not raise clientError error')
  })
  broker.on('connectionError', function (client, err) {
    t.equal(err.message, 'unacceptable protocol version')
  })
})

// [MQTT-3.1.2-1], Guarded in mqtt-packet
test('reject client requested for unsupported protocol version', function (t) {
  t.plan(2)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 2,
    clean: true,
    clientId: 'my-client',
    keepalive: 0
  })
  s.outStream.on('data', function (packet) {
    t.fail('no data sent')
  })
  broker.on('connectionError', function (client, err) {
    t.equal(err.message, 'Invalid protocol version')
    t.equal(broker.connectedClients, 0)
  })
})

// Guarded in mqtt-packet
test('reject clients with no clientId running on MQTT 3.1.0', function (t) {
  t.plan(2)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQIsdp',
    protocolVersion: 3,
    clean: true,
    keepalive: 0
  })
  s.outStream.on('data', function (packet) {
    t.fail('no data sent')
  })
  broker.on('connectionError', function (client, err) {
    t.equal(err.message, 'clientId must be supplied before 3.1.1')
    t.equal(broker.connectedClients, 0)
  })
})

// [MQTT-3.1.3-7], Guarded in mqtt-packet
test('reject clients without clientid and clean=false on MQTT 3.1.1', function (t) {
  t.plan(2)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: false,
    clientId: '',
    keepalive: 0
  })
  s.outStream.on('data', function (packet) {
    t.fail('no data sent')
  })
  broker.on('connectionError', function (client, err) {
    t.equal(err.message, 'clientId must be given if cleanSession set to 0')
    t.equal(broker.connectedClients, 0)
  })
})

test('clients without clientid and clean=true on MQTT 3.1.1 will get a generated clientId', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    keepalive: 0
  })
  s.outStream.on('data', function (packet) {
    t.equal(packet.cmd, 'connack')
    t.equal(packet.returnCode, 0)
    t.equal(broker.connectedClients, 1)
  })
  broker.on('connectionError', function (client, err) {
    t.error(err, 'no error')
  })
  broker.on('client', function (client) {
    t.ok(client.id.startsWith('aedes_'))
  })
})

test('client connect error while fetching subscriptions', function (t) {
  t.plan(1)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  broker.persistence.subscriptionsByClient = function (c, cb) {
    cb(new Error('error'), [], c)
  }

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: false,
    clientId: 'my-client',
    keepalive: 0
  })

  broker.on('clientError', function (client, err) {
    t.pass('throws error')
  })
})

test('client connect clear outgoing', function (t) {
  t.plan(1)

  var clientId = 'abcde'
  var brokerId = 'pippo'

  const broker = aedes({ id: brokerId })
  t.tearDown(broker.close.bind(broker))

  var subs = [{ clientId: clientId }]
  var packet = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 1,
    brokerId: brokerId,
    brokerCounter: 2,
    retain: true,
    messageId: 42,
    dup: false
  }

  broker.persistence.outgoingEnqueueCombi(subs, packet, function () {
    const s = setup(broker)

    console.log(broker.persistence._outgoing[clientId][0])

    s.inStream.write({
      cmd: 'connect',
      protocolId: 'MQTT',
      protocolVersion: 4,
      clean: true,
      clientId: clientId,
      keepalive: 0
    })

    broker.on('clientReady', function (client) {
      broker.persistence.outgoingUpdate(client, packet, function (err) {
        t.equal('no such packet', err.message, 'packet not found')
      })
    })
  })
})

test('clients with zero-byte clientid and clean=true on MQTT 3.1.1 will get a generated clientId', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: '',
    keepalive: 0
  })
  s.outStream.on('data', function (packet) {
    t.equal(packet.cmd, 'connack')
    t.equal(packet.returnCode, 0)
    t.equal(broker.connectedClients, 1)
  })
  broker.on('connectionError', function (client, err) {
    t.error(err, 'no error')
  })
  broker.on('client', function (client) {
    t.ok(client.id.startsWith('aedes_'))
  })
})

// [MQTT-3.1.3-7]
test('reject clients with > 23 clientId length in MQTT 3.1.0', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQIsdp',
    protocolVersion: 3,
    clean: true,
    clientId: 'abcdefghijklmnopqrstuvwxyz',
    keepalive: 0
  })
  s.outStream.on('data', function (packet) {
    t.equal(packet.cmd, 'connack')
    t.equal(packet.returnCode, 2, 'identifier rejected')
    t.equal(broker.connectedClients, 0)
  })
  broker.on('connectionError', function (client, err) {
    t.equal(err.message, 'identifier rejected')
  })
})

test('connect with > 23 clientId length in MQTT 3.1.1', function (t) {
  t.plan(3)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'abcdefghijklmnopqrstuvwxyz',
    keepalive: 0
  })
  s.outStream.on('data', function (packet) {
    t.equal(packet.cmd, 'connack')
    t.equal(packet.returnCode, 0)
    t.equal(broker.connectedClients, 1)
  })
  broker.on('connectionError', function (client, err) {
    t.error(err, 'no error')
  })
})

// [MQTT-3.1.0-1]
test('the first Packet MUST be a CONNECT Packet', function (t) {
  t.plan(2)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const packet = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false
  }
  const s = setup(broker)
  s.inStream.write(packet)

  broker.on('connectionError', function (client, err) {
    t.equal(err.message, 'Invalid protocol')
  })
  setImmediate(() => {
    t.ok(s.conn.destroyed, 'close connection if first packet is not a CONNECT')
    s.conn.destroy()
  })
})

// [MQTT-3.1.0-2]
test('second CONNECT Packet sent from a Client as a protocol violation and disconnect the Client', function (t) {
  t.plan(4)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const packet = {
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'my-client',
    keepalive: 0
  }
  broker.on('clientError', function (client, err) {
    t.equal(err.message, 'Invalid protocol')
  })
  const s = connect(setup(broker), { clientId: 'abcde' })
  s.broker.on('clientReady', function () {
    t.ok(broker.clients.abcde.connected)
    // destory client when there is a 2nd cmd:connect, even the clientId is dfferent
    s.inStream.write(packet)
    setImmediate(() => {
      t.equal(broker.clients.abcde, undefined, 'client instance is removed')
      t.ok(s.conn.destroyed, 'close connection if packet is a CONNECT after network is established')
    })
  })
})

test('reject second CONNECT Packet sent while first CONNECT still in preConnect stage', function (t) {
  t.plan(2)

  const packet1 = {
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'my-client-1',
    keepalive: 0
  }
  const packet2 = {
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'my-client-2',
    keepalive: 0
  }

  var i = 0
  const broker = aedes({
    preConnect: function (client, done) {
      var ms = i++ === 0 ? 2000 : 500
      setTimeout(function () {
        done(null, true)
      }, ms)
    }
  })
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  broker.on('connectionError', function (client, err) {
    t.equal(err.info.clientId, 'my-client-2')
    t.equal(err.message, 'Invalid protocol')
  })

  const msg = async (s, ms, msg) => {
    await delay(ms)
    s.inStream.write(msg)
  }

  ;(async () => {
    await Promise.all([msg(s, 100, packet1), msg(s, 200, packet2)])
  })().catch(
    (error) => {
      t.fail(error)
    }
  )
})

// [MQTT-3.1.2-1], Guarded in mqtt-packet
test('reject clients with wrong protocol name', function (t) {
  t.plan(2)

  const broker = aedes()
  t.tearDown(broker.close.bind(broker))

  const s = setup(broker)

  s.inStream.write({
    cmd: 'connect',
    protocolId: 'MQTT_hello',
    protocolVersion: 3,
    clean: true,
    clientId: 'my-client',
    keepalive: 0
  })
  s.outStream.on('data', function (packet) {
    t.fail('no data sent')
  })
  broker.on('connectionError', function (client, err) {
    t.equal(err.message, 'Invalid protocolId')
    t.equal(broker.connectedClients, 0)
  })
})

test('After first CONNECT Packet, others are queued until \'connect\' event', function (t) {
  t.plan(2)

  const queueLimit = 50
  const broker = aedes({ queueLimit })
  t.tearDown(broker.close.bind(broker))

  const publishP = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false
  }

  const connectP = {
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'abcde',
    keepalive: 0
  }

  const s = setup(broker)
  s.inStream.write(connectP)

  process.once('warning', e => t.fail('Memory leak detected'))

  for (let i = 0; i < queueLimit; i++) {
    s.inStream.write(publishP)
  }

  broker.on('client', function (client) {
    t.equal(client._parser._queue.length, queueLimit, 'Packets have been queued')

    client.once('connected', () => {
      t.equal(client._parser._queue, null, 'Queue is empty')
      s.conn.destroy()
    })
  })
})

test('Test queue limit', function (t) {
  t.plan(1)

  const queueLimit = 50
  const broker = aedes({ queueLimit })
  t.tearDown(broker.close.bind(broker))

  const publishP = {
    cmd: 'publish',
    topic: 'hello',
    payload: Buffer.from('world'),
    qos: 0,
    retain: false
  }

  const connectP = {
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'abcde',
    keepalive: 0
  }

  const s = setup(broker)
  s.inStream.write(connectP)

  process.once('warning', e => t.fail('Memory leak detected'))

  for (let i = 0; i < queueLimit + 1; i++) {
    s.inStream.write(publishP)
  }

  broker.on('connectionError', function (conn, err) {
    t.equal(err.message, 'Client queue limit reached', 'Queue error is thrown')
    s.conn.destroy()
  })
})

;[['fail with no error msg', 2, null, false], ['succeed with no error msg', 8, null, true], ['fail with error msg', 5, new Error('connection banned'), false], ['succeed with error msg', 5, new Error('connection banned'), true]].forEach(function (ele, idx) {
  const title = ele[0]
  const plan = ele[1]
  const err = ele[2]
  const ok = ele[3]
  test('preConnect handler - ' + title, function (t) {
    t.plan(plan)

    const broker = aedes({
      preConnect: function (client, done) {
        t.ok(client.connecting)
        t.notOk(client.connected)
        return done(err, ok)
      }
    })
    t.tearDown(broker.close.bind(broker))

    const s = setup(broker)

    s.inStream.write({
      cmd: 'connect',
      protocolId: 'MQTT',
      protocolVersion: 4,
      clean: true,
      clientId: 'my-client-' + idx,
      keepalive: 0
    })
    broker.on('client', function (client) {
      if (ok && !err) {
        t.ok(client.connecting)
        t.notOk(client.connected)
        t.pass('register client ok')
      } else {
        t.fail('no reach here')
      }
    })
    broker.on('clientReady', function (client) {
      t.notOk(client.connecting)
      t.ok(client.connected)
      t.pass('connect ok')
    })
    broker.on('clientError', function (client, err) {
      t.fail('no client error')
    })
    broker.on('connectionError', function (client, err) {
      if (err) {
        t.notOk(client.connecting)
        t.notOk(client.connected)
        t.equal(err.message, 'connection banned')
      } else {
        t.fail('no connection error')
      }
    })
  })
})

// websocket-stream based connections
test('websocket clients have access to the request object', function (t) {
  t.plan(3)

  const port = 4883
  const broker = aedes()
  broker.on('client', function (client) {
    if (client.req) {
      t.pass('client request object present')
      if (client.req.headers) {
        t.equal('sample', client.req.headers['x-test-protocol'])
      }
    } else {
      t.fail('no request object present')
    }
  })

  const server = http.createServer()
  ws.createServer({
    server: server
  }, broker.handle)

  server.listen(port, function (err) {
    t.error(err, 'no error')
  })

  const client = mqtt.connect(`ws://localhost:${port}`, {
    wsOptions: {
      headers: {
        'X-Test-Protocol': 'sample'
      }
    }
  })

  t.tearDown(() => {
    client.end(true)
    broker.close()
    server.close()
  })
})

// test ipAddress property presence when trustProxy is enabled
test('tcp clients have access to the ipAddress from the socket', function (t) {
  t.plan(2)

  const port = 4883
  const broker = aedes({
    preConnect: function (client, done) {
      if (client && client.connDetails && client.connDetails.ipAddress) {
        client.ip = client.connDetails.ipAddress
        t.equal('::ffff:127.0.0.1', client.ip)
      } else {
        t.fail('no ip address present')
      }
      done(null, true)
    },
    decodeProtocol: protocolDecoder,
    trustProxy: true
  })

  const server = net.createServer(broker.handle)
  server.listen(port, function (err) {
    t.error(err, 'no error')
  })

  const client = mqtt.connect({
    port,
    keepalive: 0,
    clientId: 'mqtt-client',
    clean: false
  })

  t.tearDown(() => {
    client.end(true)
    broker.close()
    server.close()
  })
})

test('tcp proxied (protocol v1) clients have access to the ipAddress(v4)', function (t) {
  t.plan(2)

  const port = 4883
  const clientIp = '192.168.0.140'
  const packet = {
    cmd: 'connect',
    protocolId: 'MQIsdp',
    protocolVersion: 3,
    clean: true,
    clientId: 'my-client-proxyV1',
    keepalive: 0
  }

  const buf = mqttPacket.generate(packet)
  const src = new proxyProtocol.Peer(clientIp, 12345)
  const dst = new proxyProtocol.Peer('127.0.0.1', port)
  const protocol = new proxyProtocol.V1BinaryProxyProtocol(
    proxyProtocol.INETProtocol.TCP4,
    src,
    dst,
    buf
  ).build()

  const broker = aedes({
    preConnect: function (client, done) {
      if (client.connDetails && client.connDetails.ipAddress) {
        client.ip = client.connDetails.ipAddress
        t.equal(clientIp, client.ip)
      } else {
        t.fail('no ip address present')
      }
      done(null, true)
    },
    decodeProtocol: protocolDecoder,
    trustProxy: true
  })

  const server = net.createServer(broker.handle)
  server.listen(port, function (err) {
    t.error(err, 'no error')
  })

  const client = net.connect({
    port,
    timeout: 0
  }, function () {
    client.write(protocol)
  })

  t.tearDown(() => {
    client.end()
    broker.close()
    server.close()
  })
})

test('tcp proxied (protocol v2) clients have access to the ipAddress(v4)', function (t) {
  t.plan(2)

  const port = 4883
  const clientIp = '192.168.0.140'
  const packet = {
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'my-client-proxyV2'
  }

  const protocol = new proxyProtocol.V2ProxyProtocol(
    proxyProtocol.Command.LOCAL,
    proxyProtocol.TransportProtocol.DGRAM,
    new proxyProtocol.IPv4ProxyAddress(
      proxyProtocol.IPv4Address.createFrom(clientIp.split('.')),
      12345,
      proxyProtocol.IPv4Address.createFrom([127, 0, 0, 1]),
      port
    ),
    mqttPacket.generate(packet)
  ).build()

  const broker = aedes({
    preConnect: function (client, done) {
      if (client.connDetails && client.connDetails.ipAddress) {
        client.ip = client.connDetails.ipAddress
        t.equal(clientIp, client.ip)
      } else {
        t.fail('no ip address present')
      }
      done(null, true)
    },
    decodeProtocol: protocolDecoder,
    trustProxy: true
  })

  const server = net.createServer(broker.handle)
  server.listen(port, function (err) {
    t.error(err, 'no error')
  })

  const client = net.createConnection(
    {
      port,
      timeout: 0
    }, function () {
      client.write(Buffer.from(protocol))
    }
  )

  t.tearDown(() => {
    client.end()
    broker.close()
    server.close()
  })
})

test('tcp proxied (protocol v2) clients have access to the ipAddress(v6)', function (t) {
  t.plan(2)

  const port = 4883
  const clientIpArray = [0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 192, 168, 1, 128]
  const clientIp = '::ffff:c0a8:180:'
  const packet = {
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'my-client-proxyV2'
  }

  const protocol = new proxyProtocol.V2ProxyProtocol(
    proxyProtocol.Command.PROXY,
    proxyProtocol.TransportProtocol.STREAM,
    new proxyProtocol.IPv6ProxyAddress(
      proxyProtocol.IPv6Address.createFrom(clientIpArray),
      12345,
      proxyProtocol.IPv6Address.createWithEmptyAddress(),
      port
    ),
    mqttPacket.generate(packet)
  ).build()

  const broker = aedes({
    preConnect: function (client, done) {
      if (client.connDetails && client.connDetails.ipAddress) {
        client.ip = client.connDetails.ipAddress
        t.equal(clientIp, client.ip)
      } else {
        t.fail('no ip address present')
      }
      done(null, true)
    },
    decodeProtocol: protocolDecoder,
    trustProxy: true
  })

  const server = net.createServer(broker.handle)
  server.listen(port, function (err) {
    t.error(err, 'no error')
  })

  const client = net.createConnection(
    {
      port,
      timeout: 0
    }, function () {
      client.write(Buffer.from(protocol))
    }
  )

  t.tearDown(() => {
    client.end()
    broker.close()
    server.close()
  })
})

test('websocket clients have access to the ipAddress from the socket (if no ip header)', function (t) {
  t.plan(2)

  const clientIp = '::ffff:127.0.0.1'
  const port = 4883
  const broker = aedes({
    preConnect: function (client, done) {
      if (client.connDetails && client.connDetails.ipAddress) {
        client.ip = client.connDetails.ipAddress
        t.equal(clientIp, client.ip)
      } else {
        t.fail('no ip address present')
      }
      done(null, true)
    },
    decodeProtocol: protocolDecoder,
    trustProxy: true
  })

  const server = http.createServer()
  ws.createServer({
    server: server
  }, broker.handle)

  server.listen(port, function (err) {
    t.error(err, 'no error')
  })

  const client = mqtt.connect(`ws://localhost:${port}`)

  t.tearDown(() => {
    client.end(true)
    broker.close()
    server.close()
  })
})

test('websocket proxied clients have access to the ipAddress from x-real-ip header', function (t) {
  t.plan(2)

  const clientIp = '192.168.0.140'
  const port = 4883
  const broker = aedes({
    preConnect: function (client, done) {
      if (client.connDetails && client.connDetails.ipAddress) {
        client.ip = client.connDetails.ipAddress
        t.equal(clientIp, client.ip)
      } else {
        t.fail('no ip address present')
      }
      done(null, true)
    },
    decodeProtocol: protocolDecoder,
    trustProxy: true
  })

  const server = http.createServer()
  ws.createServer({
    server: server
  }, broker.handle)

  server.listen(port, function (err) {
    t.error(err, 'no error')
  })

  const client = mqtt.connect(`ws://localhost:${port}`, {
    wsOptions: {
      headers: {
        'X-Real-Ip': clientIp
      }
    }
  })

  t.tearDown(() => {
    client.end(true)
    broker.close()
    server.close()
  })
})

test('websocket proxied clients have access to the ipAddress from x-forwarded-for header', function (t) {
  t.plan(2)

  const clientIp = '192.168.0.140'
  const port = 4883
  const broker = aedes({
    preConnect: function (client, done) {
      if (client.connDetails && client.connDetails.ipAddress) {
        client.ip = client.connDetails.ipAddress
        t.equal(clientIp, client.ip)
      } else {
        t.fail('no ip address present')
      }
      done(null, true)
    },
    decodeProtocol: protocolDecoder,
    trustProxy: true
  })

  const server = http.createServer()
  ws.createServer({
    server: server
  }, broker.handle)

  server.listen(port, function (err) {
    t.error(err, 'no error')
  })

  const client = mqtt.connect(`ws://localhost:${port}`, {
    wsOptions: {
      headers: {
        'X-Forwarded-For': clientIp
      }
    }
  })

  t.tearDown(() => {
    client.end(true)
    broker.close()
    server.close()
  })
})

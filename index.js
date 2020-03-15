const fastify = require('fastify')({ logger: false })
const { isProd, gotMock } = require('./utils')
const got = isProd() ? require('got') : gotMock
const parseClients = require('./parse-clients')
const { port, configFile } = require('./config.js')

const clients = parseClients(configFile)

fastify.register(require('fastify-formbody'))
fastify.register(require('fastify-cors'), {
  methods: ['GET', 'POST'],
  origin: [
    /:\/\/das-mechabus\.jacobsmith\.tech/,
    // These are the local machines
    /:\/\/10.0.0.[2-4]/,
    ...Object.values(clients),
  ],
})

fastify.post('/', async (request, response) => {
  const { id, state, action } = JSON.parse(request.body)
  const client = clients[id]

  if (!client) {
    response.code(404)
    response.send({ Error: 'Controller not found' })
  }

  if (action === 'toggle') {
    const reply = await got(`http://${client}/?action=${action}`)
    console.log(reply)
    response.send(reply)
  }
  if (typeof state === 'number') {
    const reply = await got(`http://${client}/?state=${state}`)
    console.log(reply)
    response.send(reply)
  }
  response.code(400)
  response.send({ Error: 'Invalid request' })
})

;(async () => {
  await fastify.listen(port)
  console.log(`server listening on ${fastify.server.address().port}`)
})()

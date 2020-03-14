const express = require('express')
const got = require('got')
const parseClients = require('./parse-clients')
const bodyParser = require('body-parser')
const {port, configFile} = require('./config.js')

const app = express()
app.use(bodyParser.urlencoded({extended: true}))

const clients = parseClients(configFile)

app.post('/', async (request, response) => {
  const {id, state} = request.body
  const client = clients[id]
  if (!client) {
    return response.send('Error: Controller not found')
  }
  const reply = await got(`http://${client}/?state=${state}`)
  console.log(reply)
  return response.send(state)
})

app.listen(port, () => console.log(`Listening on: ${port}`))

var debug = require('debug')('risingstack/trace')
var microtime = require('../optionalDependencies/microtime')
var uuid = require('node-uuid')
var cls = require('continuation-local-storage')

var assign = require('lodash.assign')

var CollectorApi = require('./api')
var Metrics = require('./metrics')
var Healthcheck = require('./healthcheck')
var consts = require('../consts')
var ReservoirSampler = require('./reservoir_sampler')

var REQUEST_ID = 'request-id'
var SPAN_ID = 'span-id'
var MUST_COLLECT_LIMIT = 100

function Agent (options) {
  debug('Agent is initializing...')
  var _this = this
  this.cls = cls.createNamespace('trace')
  this.collectorApi = CollectorApi.create(options.config)
  // config
  this.config = options.config
  this.collectInterval = this.config.collectInterval

  this.totalRequestCount = 0
  this.mustCollectCount = 0

  // init required variables
  this.partials = {}

  this.apmMetrics = Metrics.apm.create({
    collectorApi: this.collectorApi,
    config: this.config
  })

  this.healthcheck = Healthcheck.create({
    collectorApi: this.collectorApi,
    config: this.config
  })

  this.rpmMetrics = Metrics.rpm.create({
    collectorApi: this.collectorApi,
    config: this.config
  })

  this.externalEdgeMetrics = Metrics.externalEdge.create({
    collectorApi: this.collectorApi,
    config: this.config
  })

  this.incomingEdgeMetrics = Metrics.incomingEdge.create({
    collectorApi: this.collectorApi,
    config: this.config
  })

  this.collectorApi.getService(function (err, serviceKey) {
    if (err) {
      return debug(err.message)
    }
    debug('Agent serviceKey is set to: ', serviceKey)
    _this.serviceKey = serviceKey
    _this.start()
  })

  this.reservoirSampler = new ReservoirSampler(MUST_COLLECT_LIMIT)
}

Agent.prototype.start = function () {
  var _this = this
  debug('Agent started collecting')
  this.transactionIntervalId = setInterval(function () {
    _this._send()
  }, this.collectInterval)
}

Agent.prototype.stop = function () {
  debug('Agent stopped collecting')
  clearInterval(this.transactionIntervalId)
}

Agent.prototype.getServiceKey = function () {
  return this.serviceKey
}

Agent.prototype.getConfig = function () {
  return this.config
}

Agent.prototype.serverReceive = function (data) {
  this.totalRequestCount++
  var spanId = data.spanId
  var span = this.openSpan(data)
  var parentId

  if (!isNaN(data.parentId)) {
    parentId = parseInt(data.parentId, 10)
  }

  var transportDelay = data.time - data.originTime

  this.incomingEdgeMetrics.report({
    serviceKey: data.parentId,
    protocol: data.protocol,
    transportDelay: transportDelay
  })

  span.events.push({
    time: data.time || microtime.now(),
    type: Agent.SERVER_RECV,
    data: {
      rpcId: spanId,
      endpoint: data.url,
      method: data.method,
      parent: parentId,
      originTime: data.originTime
    }
  })
}

Agent.prototype.serverSend = function (data) {
  var spanId = data.spanId
  var span = this.findSpan(data.id)

  if (!span) {
    debug('span was not found for serverSend - it shouldn\'t happen', data.id, data.spanId)
    return
  }

  span.events.push({
    time: data.time || microtime.now(),
    type: Agent.SERVER_SEND,
    data: {
      rpcId: spanId,
      statusCode: data.statusCode
    }
  })

  span.isForceSampled = span.isForceSampled || data.mustCollect === consts.MUST_COLLECT.ERROR

  if (span.isForceSampled) {
    this.reservoirSampler.addReturnsSuccess(span)
  }

  delete this.partials[data.id]
}

Agent.prototype.clientSend = function (data) {
  var span = this.findSpan(data.id)

  if (!span) {
    return
  }

  if (data.err) {
    span.isForceSampled = true
  }

  var event = {
    time: data.time || microtime.now()
  }

  if (data.err) {
    assign(event, {
      type: Agent.ERROR,
      data: {
        rpcId: data.spanId,
        type: data.err.type,
        message: data.err.message,
        raw: data.err.raw
      }
    })
  } else {
    assign(event, {
      type: Agent.CLIENT_SEND,
      data: {
        rpcId: data.spanId,
        host: data.host,
        endpoint: data.url,
        method: data.method
      }
    })
  }

  span.events.push(event)

  var hasServerReceive = span.events.some(function (event) {
    return event.type === Agent.SERVER_RECV
  })

  var hasClientSend = span.events.some(function (event) {
    return event.type === Agent.CLIENT_SEND
  })

  // for now worker requests are not supported, clean them up
  if (!hasServerReceive && hasClientSend) {
    delete this.partials[data.id]
  }
}

Agent.prototype.clientReceive = function (data) {
  var span = this.findSpan(data.id)

  // report external edges only if service is not instrumented by Trace
  if (typeof data.targetServiceKey === 'undefined') {
    if (!data.statusCode || data.statusCode < 500) {
      this.externalEdgeMetrics.report({
        targetHost: data.host,
        protocol: data.protocol,
        status: data.status,
        responseTime: data.responseTime
      })
    }
  }

  if (!span) {
    return
  }

  data.time = data.time || this.getMicrotime()

  span.events.push({
    time: data.time,
    type: Agent.CLIENT_RECV,
    data: {
      rpcId: data.spanId,
      statusCode: data.statusCode
    }
  })
}

Agent.prototype.onCrash = function (data) {
  var span = this.findSpan(this.getTransactionId())
  var spanId = this.getSpanId()

  if (!span) {
    return
  }

  span.isForceSampled = true

  span.events.push({
    time: microtime.now(),
    type: Agent.ERROR,
    data: {
      rpcId: spanId,
      type: 'system-error',
      message: data.stackTrace.message,
      raw: {
        stack: data.stackTrace.stack
      }
    }
  })

  this.reservoirSampler.addReturnsSuccess(span)

  this._send({
    isSync: true
  })
}

Agent.prototype.report = function (name, data, error) {
  var traceId = this.getTransactionId()
  var spanId = this.getSpanId()
  var span = this.findSpan(traceId)

  if (!span) {
    return
  }

  var event = {
    time: microtime.now()
  }
  if (error) {
    assign(event, {
      type: Agent.ERROR,
      data: {
        rpcId: spanId,
        name: name,
        type: 'user-sent-error',
        message: data.message,
        raw: data
      }
    })
  } else {
    assign(event, {
      type: Agent.USER_SENT,
      data: {
        rpcId: spanId,
        name: name,
        raw: data
      }
    })
  }

  // check if we already have a user-sent event with the same name
  var isFound = span.events.some(function (event) {
    return event.data && event.data.name === name
  })

  if (!isFound) {
    span.events.push(event)
    this.partials[traceId] = span
  } else {
    debug('Already has a user-sent event with the name "%s"', name)
  }
}

Agent.prototype.reportError = function (errorName, errorData) {
  this.report(errorName, errorData, true)
}

Agent.prototype.findSpan = function (transactionId) {
  var span
  // check if we have a partial with the id
  if (!transactionId || !this.partials[transactionId] || !this.partials[transactionId].events) {
    debug('missing transaction', transactionId)
    return
  }

  span = this.partials[transactionId]
  // check if we had an SR before, if not, discard the span
  var hasServerReceive = span.events.some(function (event) {
    return event.type === Agent.SERVER_RECV
  })

  if (!hasServerReceive) {
    debug('no SR found in findSpan, returning')
    return
  }

  return span
}

Agent.prototype.openSpan = function (data) {
  var requestId = data.id

  if (!requestId) {
    return
  }

  var newSpan = {
    requestId: requestId,
    isSampled: false,
    isForceSampled: false,
    events: []
  }
  this.partials[requestId] = this.partials[requestId] || newSpan
  return this.partials[requestId]
}

Agent.prototype.setTransactionId = function (value) {
  return this.cls.set(REQUEST_ID, value)
}

Agent.prototype.getTransactionId = function () {
  return this.cls.get(REQUEST_ID)
}

Agent.prototype.setSpanId = function (value) {
  return this.cls.set(SPAN_ID, value)
}

Agent.prototype.getSpanId = function () {
  return this.cls.get(SPAN_ID)
}

Agent.prototype.clearTransaction = function (requestId) {
  delete this.partials[requestId]
}

Agent.prototype.bind = function (fn) {
  return this.cls.bind(fn)
}

Agent.prototype.bindEmitter = function (emitter) {
  return this.cls.bindEmitter(emitter)
}

Agent.prototype.generateSpanId = function () {
  return this.generateId()
}

Agent.prototype.generateId = function () {
  return uuid.v4()
}

Agent.prototype.getMicrotime = function () {
  return microtime.now()
}

Agent.prototype._send = function (options) {
  debug('sending logs to the trace service')
  var spans = this.reservoirSampler.getItems()
  if (spans.length > 0) {
    var dataBag = {
      sample: {
        rate: 1,
        totalRequestCount: 1
      },
      spans: spans
    }

    this.totalRequestCount = 0
    this.reservoirSampler = new ReservoirSampler(MUST_COLLECT_LIMIT)
    this.collectorApi.sendSamples(dataBag, options && options.isSync)
  }
}

module.exports.CLIENT_SEND = Agent.CLIENT_SEND = 'cs'
module.exports.CLIENT_RECV = Agent.CLIENT_RECV = 'cr'
module.exports.SERVER_SEND = Agent.SERVER_SEND = 'ss'
module.exports.SERVER_RECV = Agent.SERVER_RECV = 'sr'
module.exports.ERROR = Agent.ERROR = 'err'
module.exports.USER_SENT = Agent.USER_SENT = 'us'

module.exports.create = function (options) {
  return new Agent(options)
}

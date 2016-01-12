var http = require('http')
var util = require('util')
var debug = require('debug')('micromono:server:pipe')
var argsNames = require('js-args-names')
var ServicePipeline = require('../service/pipeline')

exports.getServerOptions = function(options) {
  var serviceNames
  if ('string' === typeof options.service) {
    serviceNames = options.service.split(',')
    if (0 === serviceNames.length) {
      serviceNames = undefined
    }
  }
  return {
    port: options.port || 0,
    host: options.host || '127.0.0.1',
    serviceNames: serviceNames,
    serviceDir: options.serviceDir || null
  }
}

exports.requireAllServices = function(serviceNames, serviceDir, require) {
  debug('require all services: ', serviceNames)

  var services = {}
  serviceNames.forEach(function(name) {
    services[name] = require(name, serviceDir)
  })

  return {
    services: services
  }
}

exports.initFramework = function(frameworkType, framework) {
  if (!framework && 'string' === typeof frameworkType) {
    debug('initialize framework adapter for "%s"', frameworkType)
    var FrameworkAdapter = require('../web/framework/' + frameworkType)
    framework = new FrameworkAdapter()
  }

  return {
    framework: framework
  }
}

exports.prepareFrameworkForBalancer = function(framework, app) {
  framework.app = app
  return {
    attachHttpServer: framework.attachHttpServer.bind(framework)
  }
}

exports.createHttpServer = function(set) {
  var requestHandler

  function setHttpRequestHandler(fn) {
    requestHandler = fn
  }

  function serverHandler(req, res) {
    requestHandler(req, res)
  }

  var httpServer = http.createServer(serverHandler)
  // Set to global superpipe so the children pipelines can use it.
  set('httpServer', httpServer)

  return {
    httpServer: httpServer,
    setHttpRequestHandler: setHttpRequestHandler
  }
}

exports.runServices = function(createPipeline, services, runService, next) {
  var pipeline = createPipeline()
  pipeline.pipe(function setCreatePipeline() {
    return {
      createPipeline: createPipeline
    }
  })

  Object.keys(services).forEach(function(serviceName) {
    var service = services[serviceName]
    var serviceDepName = 'service:' + serviceName
    pipeline.pipe(function setServiceDepName(setDep) {
      setDep(serviceDepName, service)
    }, 'setDep')
    pipeline.pipe(runService, [serviceDepName, 'createPipeline', 'next'])
  })

  pipeline.error('errorHandler')
  pipeline.pipe(next)()
}

exports.runService = function(service, createPipeline, next) {
  debug('[%s] runService()', service.name)
  var pipeline = createPipeline()

  if (service.isRemote) {
    pipeline.pipe(function setAnnouncement(setDep) {
      setDep('announcement', service.announcement)
      var annStr = util.inspect(service.announcement, {
        colors: true,
        depth: 4
      })
      debug('[%s] remote service loaded with announcement: \n%s\n', service.name, annStr)
    }, 'setDep')
    pipeline = pipeline.concat(ServicePipeline.initRemoteService)
  } else {
    pipeline.pipe(function setService(setDep) {
      setDep('service', service)
      setDep('packagePath', service.packagePath)
    }, 'setDep')
    pipeline = pipeline
      .concat(ServicePipeline.initLocalService)

    if (service.init) {
      var initArgs = argsNames(service.init)
      // Add service.init to pipeline
      pipeline.pipe(service.init, initArgs)
    }

    pipeline = pipeline
      .concat(ServicePipeline.runLocalService)
      .pipe('generateAnnouncement',
        ['assetInfo', 'routes', 'uses', 'middlewares',
          'service', 'httpPort', 'framework', 'rpcApi',
          'rpcPort', 'rpcType', 'host', 'rpcHost'
        ], 'announcement')
  }

  pipeline.pipe('attachToMainFramework', ['mainFramework', 'framework'])

  pipeline.error('errorHandler')
  pipeline.pipe(next)()
}

exports.attachToMainFramework = function(mainFramework, framework) {
  mainFramework.app.use(framework.app)
}

exports.startServer = function(httpServer, port, host) {
  debug('start http server at %s:%s', host, port)
  httpServer.listen(port, host)
}
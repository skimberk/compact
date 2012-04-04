var path = require('path')
  , fs = require('fs')
  , mkdirp = require('mkdirp')
  , async = require('async')
  , _ = require('underscore')
  , parser = require('uglify-js').parser
  , uglifyer = require('uglify-js').uglify;

module.exports.createCompact = function(options) {

  options = _.extend({
    webPath: '',
    debug: false
  }, options);

  if (!path.existsSync(options.srcPath)) {
    throw new Error('Invalid source path \'' + options.srcPath + '\'');
  }

  if (!path.existsSync(options.destPath)) {
    mkdirp(options.destPath);
  }

  var namespaces = {}
    , namespaceGroupsCache = {}
    , compressOperationCache = {};

  function getNamespace(name) {
    if (!namespaces.hasOwnProperty(name)) {
      throw new Error('Unknown namespace \'' + name + '\'');
    }
    return namespaces[name];
  }

  function addNamespace(name, namespaceSourcePath) {

    if (!name) {
      throw new Error('Invalid namespace');
    }

    if (!namespaces[name]) {
      var newNamespace = {};
      Object.defineProperty(namespaces, name, {
        get: function() { return newNamespace; },
        configurable: false,
        enumerable: true,
        set: function(value) {
          throw new Error('You can not alter a registered namespace \'' + name + '\''); }
      });
    }
    var namespace = namespaces[name];

    function addJs(filePath) {
      if (!namespace.javascriptFiles) {
        namespace.javascriptFiles = [];
      }

      var paths = [
        path.normalize(namespaceSourcePath + '/' + filePath),
        path.normalize(options.srcPath + '/' + filePath),
        path.normalize(filePath)
      ];

      var jsPath;
      for (var i = 0; i < paths.length; i++) {
        if (path.existsSync(paths[i])) {
          jsPath = paths[i];
          continue;
        }
      }

      if (jsPath === undefined) {
        throw new Error('Unable to find \'' + filePath + '\'');
      }

      namespace.javascriptFiles.push(jsPath);

      return namespace;
    }

    namespace.addJs = addJs;

    return namespace;
  }

  function copyFile(src, callback) {
    require('util').pump(fs.createReadStream(src),
      fs.createWriteStream(options.destPath + '/' + path.basename(src)), function(error) {
        callback(error, path.normalize(options.webPath + '/' + path.basename(src)));
      });
  }

  function getJavaScriptFilesFromNamespaces(targetNamespaces) {
    var files = [];
    targetNamespaces.forEach(function(namespace) {
      if (!namespaces[namespace]) {
        throw new Error('Unknown namespace \'' + namespace + '\'. Ensure you provide a namespace that has been defined with \'addNamespace()\'');
      }
      files = files.concat(namespaces[namespace].javascriptFiles);
    });

    return _.uniq(files);
  }

  function copyJavaScript(targetNamespaces, callback) {
    var files = [];
    try {
      files = getJavaScriptFilesFromNamespaces(targetNamespaces);
    } catch (e) {
      return callback(e);
    }
    async.concatSeries(files, copyFile, function(error, results) {
     callback(undefined, results);
    });
  }

  function compressAndWriteJavascript(targetNamespaces, callback) {
    var compressedData = ''
      , files
      , compactFilename = targetNamespaces.map(function(namespace) {
          return namespace;
        }).join('-') + '.js'
      , outputFilename = options.destPath + '/' + compactFilename
      , compactedWebPath = path.normalize(options.webPath + '/' + compactFilename);

    // Only compress and write 'compactFilename' once
    if (compressOperationCache[compactFilename]) {
      return callback(undefined, compactedWebPath);
    }

    try {
      files = getJavaScriptFilesFromNamespaces(targetNamespaces);
    } catch (e) {
      return callback(e);
    }

    async.concatSeries(files, fs.readFile, function(error, contents) {

      if (error) {
        return callback(error);
      }

      fs.writeFile(outputFilename, compress(contents.join(';\n')), 'utf-8', function(error) {
        if (error) {
          return callback(error);
        }

        compressOperationCache[compactFilename] = true;
        callback(undefined, compactedWebPath);
      });
    });
  }

  function compress(data) {
    var ast = parser.parse(data);
    ast = uglifyer.ast_mangle(ast);
    ast = uglifyer.ast_squeeze(ast);
    return uglifyer.gen_code(ast);
  }

  function processNamespaceGroups(namespaceGroups, callback) {

    // Use a different compress function for debug
    var compressFunction = options.debug ? copyJavaScript : compressAndWriteJavascript;

    var hash = namespaceGroups.join('|');
    if (!namespaceGroupsCache[hash]) {
      async.map(namespaceGroups, compressFunction, function(error, results) {
        if (error) {
          return callback(error);
        }
        results = _.flatten(results);
        // No caching in debug mode
        if (options.debug) {
          namespaceGroupsCache[hash] = results;
        }
        callback(undefined, results);
      });
    } else {
      callback(undefined, namespaceGroupsCache[hash]);
    }
  }

  function compactJavascript() {
    if (arguments.length === 0) {
      throw new Error('You must pass one or more arrays containing valid namespace names');
    }
    var namespaceGroups = Array.prototype.slice.call(arguments);

    return function(req, res, next) {
      processNamespaceGroups(namespaceGroups, function(error, results) {
        if (error) {
          return next(error);
        }
        var app = req.app;
        app.configure(function() {
          app.helpers({
            compactJs: function() {
              return results;
            },
            compactJsHtml: function() {
              return results.map(function(filename) {
                return '<script src="' + filename + '" type="text/javascript" async="true"></script>';
              }).join('');
            }
          });
        });

        next();
      });
    };
  }

  return {
    addNamespace: addNamespace,
    js: compactJavascript,
    ns: namespaces
  };
};
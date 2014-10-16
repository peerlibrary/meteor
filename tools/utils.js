var Future = require('fibers/future');
var _ = require('underscore');
var fiberHelpers = require('./fiber-helpers.js');
var archinfo = require('./archinfo.js');
var files = require('./files.js');
var packageVersionParser = require('./package-version-parser.js');
var semver = require('semver');
var os = require('os');
var fs = require('fs');
var url = require('url');
var child_process = require('child_process');

var utils = exports;

// Parses <protocol>://<host>:<port> into an object { protocol: *, host:
// *, port: * }. The input can also be of the form <host>:<port> or just
// <port>. We're not simply using 'url.parse' because we want '3000' to
// parse as {host: undefined, protocol: undefined, port: '3000'}, whereas
// 'url.parse' would give us {protocol:' 3000', host: undefined, port:
// undefined} or something like that.
//
// 'defaults' is an optional object with 'host', 'port', and 'protocol' keys.
var parseUrl = function (str, defaults) {
  // XXX factor this out into a {type: host/port}?

  defaults = defaults || {};
  var defaultHost = defaults.host || undefined;
  var defaultPort = defaults.port || undefined;
  var defaultProtocol = defaults.protocol || undefined;

  if (str.match(/^[0-9]+$/)) { // just a port
    return {
      port: str,
      host: defaultHost,
      protocol: defaultProtocol };
  }

  var hasScheme = exports.hasScheme(str);
  if (! hasScheme) {
    str = "http://" + str;
  }

  var parsed = url.parse(str);
  if (! parsed.protocol.match(/\/\/$/)) {
    // For easy concatenation, add double slashes to protocols.
    parsed.protocol = parsed.protocol + "//";
  }
  return {
    protocol: hasScheme ? parsed.protocol : defaultProtocol,
    host: parsed.hostname || defaultHost,
    port: parsed.port || defaultPort
  };
};

var ipAddress = function () {
  var uniload = require("./uniload.js");
  var netroute = uniload.load({ packages: ["netroute"] }).
        netroute.NpmModuleNetroute;
  var info = netroute.getInfo();
  var defaultRoute = _.findWhere(info.IPv4 || [], { destination: "0.0.0.0" });
  if (! defaultRoute) {
    return null;
  }

  var iface = defaultRoute["interface"];

  var getAddress = function (iface) {
    var interfaces = os.networkInterfaces();
    return _.findWhere(interfaces[iface], { family: "IPv4" });
  };

  var address = getAddress(iface);
  if (! address) {
    // Retry after a couple seconds in case the user is connecting or
    // disconnecting from the Internet.
    utils.sleepMs(2000);
    address = getAddress(iface);
    if (! address) {
      throw new Error(
"Interface '" + iface + "' not found in interface list, or\n" +
"does not have an IPv4 address.");
    }
  }
  return address.address;
};

exports.hasScheme = function (str) {
  return !! str.match(/^[A-Za-z][A-Za-z0-9+-\.]*\:\/\//);
};

exports.parseUrl = parseUrl;

exports.ipAddress = ipAddress;

exports.hasScheme = function (str) {
  return !! str.match(/^[A-Za-z][A-Za-z0-9+-\.]*\:\/\//);
};

// Returns a pretty list suitable for showing to the user. Input is an
// array of objects with keys 'name' and 'description'.
exports.formatList = function (unsortedItems) {
  var alphaSort = function (item) {
    return item.name;
  };
  var items = _.sortBy(unsortedItems, alphaSort);
  var longest = '';
  _.each(items, function (item) {
    if (item.name.length > longest.length)
      longest = item.name;
  });

  var pad = longest.replace(/./g, ' ');
  // it'd be nice to read the actual terminal width, but I tried
  // several methods and none of them work (COLUMNS isn't set in
  // node's environment; `tput cols` returns a constant 80). maybe
  // node is doing something weird with ptys.
  var width = 80;

  var out = '';
  _.each(items, function (item) {
    var name = item.name + pad.substr(item.name.length);
    var description = item.description || 'No description';
    var line = name + "  " + description;
    if (line.length > width) {
      line = line.substr(0, width - 3) + '...';
    }
    out += line + "\n";
  });

  return out;
};

// Determine a human-readable hostname for this computer. Prefer names
// that make sense to users (eg, the name they manually gave their
// computer on OS X, which might contain spaces) over names that have
// any particular technical significance (eg, might resolve in DNS).
exports.getHost = function () {
  var ret;
  var attempt = function () {
    var output = files.run.apply(null, arguments);
    if (output) {
      ret = output.trim();
    }
  };

  if (archinfo.matches(archinfo.host(), 'os.osx')) {
    // On OSX, to get the human-readable hostname that the user chose,
    // we call:
    //   scutil --get ComputerName
    // This can contain spaces. See
    // http://osxdaily.com/2012/10/24/set-the-hostname-computer-name-and-bonjour-name-separately-in-os-x/
    if (! ret) attempt("scutil", "--get", "ComputerName");
  }

  if (archinfo.matches(archinfo.host(), 'os.osx') ||
      archinfo.matches(archinfo.host(), 'os.linux')) {
    // On Unix-like platforms, try passing -s to hostname to strip off
    // the domain name, to reduce the extent to which the output
    // varies with DNS.
    if (! ret) attempt("hostname", "-s");
  }

  // Try "hostname" on any platform. It should work on
  // Windows. Unknown platforms that have a command called "hostname"
  // that deletes all of your files deserve what the get.
  if (! ret) attempt("hostname");

  // Otherwise, see what Node can come up with.
  return ret || os.hostname();
};

// Return standard info about this user-agent. Used when logging in to
// Meteor Accounts, mostly so that when the user is seeing a list of
// their open sessions in their profile on the web, they have a way to
// decide which ones they want to revoke.
exports.getAgentInfo = function () {
  var ret = {};

  var host = utils.getHost();
  if (host)
    ret.host = host;
  ret.agent = "Meteor";
  ret.agentVersion =
    files.inCheckout() ? "checkout" : files.getToolsVersion();
  ret.arch = archinfo.host();

  return ret;
};

// Wait for 'ms' milliseconds, and then return. Yields. (Must be
// called within a fiber, and blocks only the calling fiber, not the
// whole program.)
exports.sleepMs = function (ms) {
  if (ms <= 0)
    return;

  var fut = new Future;
  setTimeout(function () { fut['return']() }, ms);
  fut.wait();
};

// Return a short, high entropy string without too many funny
// characters in it.
exports.randomToken = function () {
  return (Math.random() * 0x100000000 + 1).toString(36);
};

// Returns a random non-privileged port number.
exports.randomPort = function () {
  return 20000 + Math.floor(Math.random() * 10000);
};

exports.parseVersionConstraint = packageVersionParser.parseVersionConstraint;
exports.parseConstraint = packageVersionParser.parseConstraint;
exports.validatePackageName = packageVersionParser.validatePackageName;

// XXX should unify this with utils.parseConstraint
exports.splitConstraint = function (constraint) {
  var m = constraint.split("@");
  var ret = { package: m[0] };
  if (m.length > 1) {
    ret.constraint = m[1];
  } else {
    ret.constraint = null;
  }
  return ret;
};


// XXX should unify this with utils.parseConstraint
exports.dealConstraint = function (constraint, pkg) {
  return { package: pkg, constraint: constraint};
};



// Check for invalid package names. Currently package names can only contain
// ASCII alphanumerics, dash, and dot, and must contain at least one letter. For
// safety reasons, package names may not start with a dot. Package names must be
// lowercase.
//
// These do not check that the package name is valid in terms of our naming
// scheme: ie, that it is prepended by a user's username. That check should
// happen at publication time.
//
// 3 variants: isValidPackageName just returns a bool.  validatePackageName
// throws an error marked with 'versionParserError'. validatePackageNameOrExit
// (which should only be used inside the implementation of a command, not
// eg package-client.js) prints and throws the "exit with code 1" exception
// on failure.

exports.isValidPackageName = function (packageName) {
  try {
    exports.validatePackageName(packageName);
    return true;
  } catch (e) {
    if (!e.versionParserError)
      throw e;
    return false;
  }
};

exports.validatePackageNameOrExit = function (packageName, options) {
  try {
    exports.validatePackageName(packageName, options);
  } catch (e) {
    if (!e.versionParserError)
      throw e;
    process.stderr.write("Error: " + e.message + "\n");
    // lazy-load main: old bundler tests fail if you add a circular require to
    // this file
    var main = require('./main.js');
    throw new main.ExitWithCode(1);
  }
};

// True if this looks like a valid email address. We deliberately
// don't support
// - quoted usernames (eg, "foo"@bar.com, " "@bar.com, "@"@bar.com)
// - IP addresses in domains (eg, foo@1.2.3.4 or the IPv6 equivalent)
// because they're weird and we don't want them in our database.
exports.validEmail = function (address) {
  return /^[^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*@([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}$/.test(address);
};

// Like Perl's quotemeta: quotes all regexp metacharacters. See
//   https://github.com/substack/quotemeta/blob/master/index.js
exports.quotemeta = function (str) {
    return String(str).replace(/(\W)/g, '\\$1');
};

// Allow a simple way to scale up all timeouts from the command line
var timeoutScaleFactor = 1.0;
if (process.env.TIMEOUT_SCALE_FACTOR) {
  timeoutScaleFactor = parseFloat(process.env.TIMEOUT_SCALE_FACTOR);
}
exports.timeoutScaleFactor = timeoutScaleFactor;

// If the given version matches a template (essentially, semver-style, but with
// a bounded number of digits per number part, and with no restriction on the
// amount of number parts, and some restrictions on legal prerelease labels),
// then return an orderKey for it. Otherwise return null.
//
// This conventional orderKey pads each part (with 0s for numbers, and ! for
// prerelease tags), and appends a $. (Because ! sorts before $, this means that
// the prerelease for a given release will sort before it. Because $ sorts
// before '.', this means that 1.2 will sort before 1.2.3.)
exports.defaultOrderKeyForReleaseVersion = function (v) {
  var m = v.match(/^(\d{1,4}(?:\.\d{1,4})*)(?:-([-A-Za-z.]{1,15})(\d{0,4}))?$/);
  if (!m)
    return null;
  var numberPart = m[1];
  var prereleaseTag = m[2];
  var prereleaseNumber = m[3];

  var hasRedundantLeadingZero = function (x) {
    return x.length > 1 && x[0] === '0';
  };
  var leftPad = function (chr, len, str) {
    if (str.length > len)
      throw Error("too long to pad!");
    var padding = new Array(len - str.length + 1).join(chr);
    return padding + str;
  };
  var rightPad = function (chr, len, str) {
    if (str.length > len)
      throw Error("too long to pad!");
    var padding = new Array(len - str.length + 1).join(chr);
    return str + padding;
  };

  // Versions must have no redundant leading zeroes, or else this encoding would
  // be ambiguous.
  var numbers = numberPart.split('.');
  if (_.any(numbers, hasRedundantLeadingZero))
    return null;
  if (prereleaseNumber && hasRedundantLeadingZero(prereleaseNumber))
    return null;

  // First, put together the non-prerelease part.
  var ret = _.map(numbers, _.partial(leftPad, '0', 4)).join('.');

  if (!prereleaseTag)
    return ret + '$';

  ret += '!' + rightPad('!', 15, prereleaseTag);
  if (prereleaseNumber)
    ret += leftPad('0', 4, prereleaseNumber);

  return ret + '$';
};

exports.isDirectory = function (dir) {
  try {
    // use stat rather than lstat since symlink to dir is OK
    var stats = fs.statSync(dir);
  } catch (e) {
    return false;
  }
  return stats.isDirectory();
};

// XXX from Underscore.String (http://epeli.github.com/underscore.string/)
exports.startsWith = function(str, starts) {
  return str.length >= starts.length &&
    str.substring(0, starts.length) === starts;
};

exports.displayRelease = function (track, version) {
  var catalog = require('./catalog.js');
  if (track === catalog.DEFAULT_TRACK)
    return "Meteor " + version;
  return track + '@' + version;
};

// Calls cb with each subset of the array "total", with non-decreasing size,
// until all subsets have been used or cb returns true. The array passed
// to cb may be safely mutated or retained by cb.
exports.generateSubsetsOfIncreasingSize = function (total, cb) {
  // We'll throw this if cb ever returns true, which is a simple way to pop us
  // out of our recursion.
  var Done = function () {};

  // Generates all subsets of size subsetSize which contain the indices already
  // in chosenIndices (and no indices that are "less than" any of them).
  var generateSubsetsOfFixedSize = function (goalSize, chosenIndices) {
    // If we've found a subset of the size we're looking for, output it.
    if (chosenIndices.length === goalSize) {
      // Change from indices into the actual elements. Note that 'elements' is
      // a newly allocated array which cb may mutate or retain.
      var elements = [];
      _.each(chosenIndices, function (index) {
        elements.push(total[index]);
      });
      if (cb(elements)) {
        throw new Done();  // unwind all the recursion
      }
      return;
    }

    // Otherwise try adding another index and call this recursively.  We're
    // trying to produce a sorted list of indices, so if there are already
    // indices, we start with the one after the biggest one we already have.
    var firstIndexToConsider = chosenIndices.length ?
          chosenIndices[chosenIndices.length - 1] + 1 : 0;
    for (var i = firstIndexToConsider; i < total.length; ++i) {
      var withThisChoice = _.clone(chosenIndices);
      withThisChoice.push(i);
      generateSubsetsOfFixedSize(goalSize, withThisChoice);
    }
  };

  try {
    for (var goalSize = 0; goalSize <= total.length; ++goalSize) {
      generateSubsetsOfFixedSize(goalSize, []);
    }
  } catch (e) {
    if (!(e instanceof Done))
      throw e;
  }
};

exports.isUrlWithSha = function (x) {
  // For now, just support http/https, which is at least less restrictive than
  // the old "github only" rule.
  return /^https?:\/\/.*[0-9a-f]{40}/.test(x);
};

// If there is a version that isn't exact, throws an Error with a
// human-readable message that is suitable for showing to the user.
// dependencies may be falsey or empty.
//
// This is talking about NPM versions specifically, not Meteor versions.
// It does not support the wrap number syntax.
exports.ensureOnlyExactVersions = function (dependencies) {
  _.each(dependencies, function (version, name) {
    // We want a given version of a smart package (package.js +
    // .npm/npm-shrinkwrap.json) to pin down its dependencies precisely, so we
    // don't want anything too vague. For now, we support semvers and urls that
    // name a specific commit by SHA.
    if (!semver.valid(version) && ! exports.isUrlWithSha(version))
      throw new Error(
        "Must declare exact version of dependency: " +
          name + '@' + version);
  });
};

exports.execFileSync = function (file, args, opts) {
  var future = new Future;

  var child_process = require('child_process');
  var eachline = require('eachline');

  if (opts && opts.pipeOutput) {
    var p = child_process.spawn(file, args, opts);

    eachline(p.stdout, fiberHelpers.bindEnvironment(function (line) {
      process.stdout.write(line + '\n');
    }));

    eachline(p.stderr, fiberHelpers.bindEnvironment(function (line) {
      process.stderr.write(line + '\n');
    }));

    p.on('exit', function (code) {
      future.return(code);
    });

    return {
      success: !future.wait(),
      stdout: "",
      stderr: ""
    };
  }

  child_process.execFile(file, args, opts, function (err, stdout, stderr) {
    future.return({
      success: ! err,
      stdout: stdout,
      stderr: stderr
    });
  });

  return future.wait();
};

exports.execFileAsync = function (file, args, opts) {
  opts = opts || {};
  var child_process = require('child_process');
  var eachline = require('eachline');
  var p = child_process.spawn(file, args, opts);
  var mapper = opts.lineMapper || _.identity;

  var logOutput = fiberHelpers.bindEnvironment(function (line) {
    if (opts.verbose) {
      line = mapper(line);
      if (line)
        console.log(line);
    }
  });

  eachline(p.stdout, logOutput);
  eachline(p.stderr, logOutput);

  return p;
};

// Patience: a way to make slow operations a little more bearable.
//
// It's frustrating when you write code that takes a while, either because it
// uses a lot of CPU or because it uses a lot of network/IO. There are two
// issues:
//   - It would be nice to apologize/explain to users that an operation is
//     taking a while... but not to spam them with the message when the
//     operation is fast. This is true no matter which kind of slowness we
///    have.
//   - In Node, consuming lots of CPU without yielding is especially bad.
//     Other IO/network tasks will stall, and you can't even kill the process!
//
// Patience is a class to help alleviate the pain of long waits.  When you're
// going to run a long operation, create a Patience object; when it's done (make
// sure to use try/finally!), stop() it.
//
// Within any code that may burn CPU for too long, call
// `utils.Patience.nudge()`.  (This is a singleton method, not a method on your
// particular patience.)  If there are any active Patience objects and it's been
// a while since your last yield, your Fiber will sleep momentarily.  (So the
// caller has to be OK with yielding --- it has to be in a Fiber and it can't be
// anything that depends for correctness on not yielding!)
//
// In addition, for each Patience, you can specify a message (a string to print
// or a function to call) and a timeout for when that gets called.  We use two
// strategies to try to call it: a standard JavaScript timeout, and as a backup
// in case we're getting CPU-starved, we also check during each nudge.  The
// message will not be printed after the Patience is stopped, which prevents you
// from apologizing to users about operations that don't end up being slow.
exports.Patience = function (options) {
  var self = this;

  self._id = nextPatienceId++;
  ACTIVE_PATIENCES[self._id] = self;

  self._whenMessage = null;
  self._message = null;
  self._messageTimeout = null;

  var now = +(new Date);

  if (options.messageAfterMs) {
    if (!options.message)
      throw Error("missing message!");
    if (typeof(options.message) !== 'string' &&
        typeof(options.message) !== 'function') {
      throw Error("message must be string or function");
    }
    self._message = "\n" + options.message;
    self._whenMessage = now + options.messageAfterMs;
    self._messageTimeout = setTimeout(function () {
      self._messageTimeout = null;
      self._printMessage();
    }, options.messageAfterMs);
  }

  // If this is the first patience we made, the next yield time is
  // YIELD_EVERY_MS from now.
  if (_.size(ACTIVE_PATIENCES) === 1) {
    nextYield = now + YIELD_EVERY_MS;
  }
};

var nextYield = null;
var YIELD_EVERY_MS = 150;
var ACTIVE_PATIENCES = {};
var nextPatienceId = 1;

exports.Patience.nudge = function () {
  // Is it time to yield?
  if (!_.isEmpty(ACTIVE_PATIENCES) &&
      +(new Date) >= nextYield) {
    nextYield = +(new Date) + YIELD_EVERY_MS;
    utils.sleepMs(1);
  }

  // save a copy, in case it gets updated
  var patienceIds = _.keys(ACTIVE_PATIENCES);
  _.each(patienceIds, function (id) {
    if (_.has(ACTIVE_PATIENCES, id)) {
      ACTIVE_PATIENCES[id]._maybePrintMessage();
    }
  });
};

_.extend(exports.Patience.prototype, {
  stop: function () {
    var self = this;
    delete ACTIVE_PATIENCES[self._id];
    if (_.isEmpty(ACTIVE_PATIENCES)) {
      nextYield = null;
    }
    self._clearMessageTimeout();
  },

  _maybePrintMessage: function () {
    var self = this;
    var now = +(new Date);

    // Is it time to print a message?
    if (self._whenMessage && +(new Date) >= self._whenMessage) {
      self._printMessage();
    }
  },

  _printMessage: function () {
    var self = this;
    // Did the timeout just fire, but we already printed the message due to a
    // nudge while CPU-bound? We're done. (This shouldn't happen since we clear
    // the timeout, but just in case...)
    if (self._message === null)
      return;
    self._clearMessageTimeout();
    // Pull out message, in case it's a function and it yields.
    var message = self._message;
    self._message = null;
    if (typeof (message) === 'function') {
      message();
    } else {
      console.log(message);
    }
  },

  _clearMessageTimeout: function () {
    var self = this;
    if (self._messageTimeout) {
      clearTimeout(self._messageTimeout);
      self._messageTimeout = null;
    }
    self._whenMessage = null;
  }
});


// This is a stripped down version of Patience, that just regulates the frequency of calling yield.
// It should behave similarly to calling yield on every iteration of a loop,
// except that it won't actually yield if there hasn't been a long enough time interval
//
// options:
//   interval: minimum interval of time between yield calls
//             (more frequent calls are simply dropped)
//
// XXX: Have Patience use ThrottledYield
exports.ThrottledYield = function (options) {
  var self = this;

  options = _.extend({ interval: 150 }, options || {});
  self.interval = options.interval;
  var now = +(new Date);

  // The next yield time is interval from now.
  self.nextYield = now + self.interval;
};

_.extend(exports.ThrottledYield.prototype, {
  yield: function () {
    var self = this;
    var now = +(new Date);

    if (now >= self.nextYield) {
      self.nextYield = now + self.interval;
      utils.sleepMs(1);
    }
  }
});


// Are we running on device?
exports.runOnDevice = function (options) {
  return !! _.intersection(options.args,
    ['ios-device', 'android-device']).length;
};

// Given the options for a 'meteor run' command, returns a parsed URL ({
// host: *, protocol: *, port: * }. The rules for --mobile-server are:
//   * If you don't specify anything for --mobile-server, then it
//     defaults to <detected ip address>:<port from --port>.
//   * If you specify something for --mobile-server, we use that,
//     defaulting to http:// as the protocol and 80 or 443 as the port.
exports.mobileServerForRun = function (options) {
  // we want to do different IP generation depending on whether we
  // are running for a device or simulator
  options = _.extend({}, options, {
    runOnDevice: exports.runOnDevice(options)
  });

  var parsedUrl = parseUrl(options.port);
  if (! parsedUrl.port) {
    throw new Error("--port must include a port.");
  }

  // XXX COMPAT WITH 0.9.2.2 -- the 'mobile-port' option is deprecated
  var mobileServer = options["mobile-server"] || options["mobile-port"];


  // if we specified a mobile server, use that

  if (mobileServer) {
    var parsedMobileServer = parseUrl(mobileServer, {
      protocol: "http://"
    });

    if (! parsedMobileServer.host) {
      throw new Error("--mobile-server must specify a hostname.");
    }

    return parsedMobileServer;
  }


  // if we are running on a device, use the auto-detected IP

  if (options.runOnDevice) {
    var myIp = ipAddress();
    if (! myIp) {
      throw new Error(
"Error detecting IP address for mobile app to connect to.\n" +
"Please specify the address that the mobile app should connect\n" +
"to with --mobile-server.");
    }

    return {
      host: myIp,
      port: parsedUrl.port,
      protocol: "http://"
    };
  }


  // we are running a simulator, use localhost:3000

  return {
    host: "localhost",
    port: parsedUrl.port,
    protocol: "http://"
  };
};

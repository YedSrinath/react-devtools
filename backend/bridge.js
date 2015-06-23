
var consts = require('./consts');

type AnyFn = (...x: any) => any;
type PayloadType = {
  type: 'inspect',
  id: string,
  path: Array<string>,
  callback: number,
} & {
  type: 'callback',
  id: string,
  args: Array<any>,
} & {
  type: 'event',
  cleaned: ?Array<Array<string>>,
  evt: string,
  data: any,
};

class Bridge {
  inspectables: Map;
  cid: number;
  cbs: Map;
  listeners: Object;
  wall: Object;

  constructor() {
    this.cbs = new Map();
    this.listeners = {};
    this.inspectables = new Map();
    this.cid = 0;
    this._buffer = [];
    this._waiting = false;
    this._lastTime = 5;
  }

  attach(wall: Object) {
    this.wall = wall
    this.wall.listen(this._handleMessage.bind(this));
  }

  inspect(id: string, path: Array<string>, cb: (val: any) => any) {
    var cid = this.cid++;
    this.cbs.set(cid, (data, cleaned, proto, protoclean) => {
      if (cleaned.length) {
        hydrate(data, cleaned);
      }
      if (proto && protoclean.length) {
        hydrate(proto, protoclean);
      }
      if (proto) {
        data[consts.proto] = proto
      }
      cb(data);
    });

    this.wall.send({
      type: 'inspect',
      callback: cid,
      path,
      id,
    });
  }

  sendOne(evt: string, data: any) {
    var cleaned = [];
    var start = performance.now();
    var san = sanitize(data, [], cleaned)
    if (cleaned.length) {
      this.inspectables.set(data.id, data);
    }
    this.wall.send({type: 'event', evt, data: san, cleaned});
    console.log('took', performance.now() - start);
  }

  send(evt: string, data: any) {
    if (!this._waiting) {
      this._buffer = [];
      this._waiting = 1
      this._waiting = setTimeout(() => {
        this.flush();
        this._waiting = null;
      }, this._lastTime * 5);
    }
    this._buffer.push({evt, data});
  }

  flush() {
    var start = performance.now();
    var events = this._buffer.map(({evt, data}) => {
      var cleaned = [];
      var san = sanitize(data, [], cleaned)
      if (cleaned.length) {
        this.inspectables.set(data.id, data);
      }
      return {type: 'event', evt, data: san, cleaned};
    });
    this.wall.send({type: 'many-events', events});
    this._buffer = [];
    this._waiting = null;
    this._lastTime = performance.now() - start
    console.log('took', this._lastTime, events.length);
  }

  forget(id: string) {
    this.inspectables.delete(id);
  }

  on(evt: string, fn: AnyFn) {
    if (!this.listeners[evt]) {
      this.listeners[evt] = [fn];
    } else {
      this.listeners[evt].push(fn);
    }
  }

  _handleMessage(payload: PayloadType) {
    var type = payload.type;
    if (payload.type === 'callback') {
      this.cbs.get(payload.id)(...payload.args);
      this.cbs.delete(payload.id);
      return;
    }

    if (payload.type === 'inspect') {
      this._inspectResponse(payload.id, payload.path, payload.callback);
      return;
    }

    if (payload.type === 'event') {
      if (payload.cleaned) {
        hydrate(payload.data, payload.cleaned);
      }
      var fns = this.listeners[payload.evt]
      if (fns) {
        fns.forEach(fn => fn(payload.data));
      }
    }

    if (payload.type === 'many-events') {
      payload.events.forEach(payload => {
        if (payload.cleaned) {
          hydrate(payload.data, payload.cleaned);
        }
        var fns = this.listeners[payload.evt]
        if (fns) {
          fns.forEach(fn => fn(payload.data));
        }
      });
    }
  }

  _inspectResponse(id: string, path: Array<string>, callback: number) {
    var val = getIn(this.inspectables.get(id), path);
    var result = {};
    var cleaned = [];
    var proto = {};
    var protoclean = [];
    if (val) {
      var protod = false
      var isFn = typeof val === 'function'
      Object.getOwnPropertyNames(val).forEach(name => {
        if (name === '__proto__') {
          protod = true;
        }
        if (isFn && (name === 'arguments' || name === 'callee' || name === 'caller')) {
          return;
        }
        result[name] = sanitize(val[name], [name], cleaned);
      });

      if (!protod && val.__proto__) {
        proto = {};
        var pIsFn = typeof val.__proto__ === 'function'
        Object.getOwnPropertyNames(val.__proto__).forEach(name => {
          if (pIsFn && (name === 'arguments' || name === 'callee' || name === 'caller')) {
            return;
          }
          proto[name] = sanitize(val.__proto__[name], [name], protoclean);
        });
      }
    }

    this.wall.send({
      type: 'callback',
      id: callback,
      args: [result, cleaned, proto, protoclean],
    });
  }

}

function hydrate(data, cleaned) {
  cleaned.forEach(path => {
    var last = path.pop();
    var obj = path.reduce((obj, attr) => obj ? obj[attr] : null, data);
    if (!obj || !obj[last]) {
      return;
    }
    var replace = {};
    replace[consts.name] = obj[last].name;
    replace[consts.type] = obj[last].type;
    replace[consts.inspected] = false;
    obj[last] = replace;
  });
}

function sanitize(data, path, cleaned, level) {
  level = level || 0;
  if ('function' === typeof data) {
    cleaned.push(path);
    return {
      name: data.name,
      type: 'function',
    };
  }
  if (!data || 'object' !== typeof data) {
    if ('string' === typeof data && data.length > 500) {
      return data.slice(0, 500) + '...';
    }
    return data;
  }
  if (data._reactFragment) {
    return 'A react fragment';
  }
  if (level > 2) {
    cleaned.push(path);
    return {
      type: Array.isArray(data) ? 'array' : 'object',
      name: data.constructor.name,
      length: data.length,
    }
  }
  if (Array.isArray(data)) {
    return data.map((item, i) => sanitize(item, path.concat([i]), cleaned, level + 1));
  }
  // TODO when this is in the iframe window, we can just use Object
  if (data.constructor && 'function' === typeof data.constructor && data.constructor.name !== 'Object') {
    cleaned.push(path);
    return {
      name: data.constructor.name,
      type: 'object',
    };
  }
  var res = {};
  for (var name in data) {
    res[name] = sanitize(data[name], path.concat([name]), cleaned, level + 1);
  }
  return res;
}

function getIn(obj, path) {
  return path.reduce((obj, attr) => {
    return obj ? obj[attr] : null;
  }, obj);
}

module.exports = Bridge;

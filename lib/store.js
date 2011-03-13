var Nohm = null;
exports.setNohm = function (originalNohm) {
  Nohm = originalNohm;
}

var Conduct = require('conductor')
, h = require(__dirname + '/helpers');

/**
 *  Saves the object by either creating, or updating it.
 */
exports.save = function save(callback) {
  var self = this,
  action = self.id ? 'update' : 'create';
  // TODO: add mechanism that checks whether an object with this.id exists
  if (!self.id) {
    self.id = + new Date() + parseInt(Math.random() * 100, 10);
  }
  this.valid(null, true, function (valid) {
    if (!valid && typeof callback === 'function') {
      h.callbackWrapper(function () {
        callback('invalid');
      });
    } else if (valid && action === 'create') {
      self.__create(callback);
    } else if (valid) {
      self.__update(false, callback);
    }
  });
}

/**
 *  Only operates on properties that have been changed
 */
exports.partialSave = function partialSave(callback) {
  if (!this.id) {
    var err = 'Trying to do a partialSave on an object without id.'
    Nohm.logError(err);
    callback(err);
  }
  var props = this.properties,
  num_updated = 0,
  success = true,
  self = this,
  validCallback = function (valid) {
    if (!valid) {
      success = false;
    }
    num_updated = num_updated - 1;
    if (num_updated <= 0) {
      if (! success) {
        callback('invalid');
      } else {
        self.__update(false, callback);
      }
    }
  };
  for (p in props) {
    if (props[p].__updated) {
      num_updated = num_updated + 1;
      self.valid(p, true, validCallback);
    }
  }
},

/**
 *  Creates a new empty (!) dataset in the database and calls __update to populate it.
 */
exports.__create = function __create(callback) {
  var self = this;
  this.getClient().incr(Nohm.prefix.ids + this.modelName, function (err, newId) {
    if (!err) {
      self.getClient().sadd(Nohm.prefix.idsets + self.modelName, newId, function (err) {
        if (err) { Nohm.logError(err); }
        self.__setUniqueIds(newId, function (err) {
          if (err) { Nohm.logError(err); }
          self.id = newId;
          self.__update(true, callback);
        });
      });
    } else {
      console.log('Nohm: Creating an object resulted in a client error: ' + util.inspect(err));
      if (typeof callback === 'function') {
        h.callbackWrapper(function () {
          callback(err);
        });
      } else {
        throw err;
      }
    }
  });
},

exports.__index = function __index(p) {
  if (this.properties[p].__numericIndex) {
    // we use scored sets for things like "get all users older than 5"
    if (this.__inDB) {
      this.getClient().zrem(Nohm.prefix.scoredindex + this.modelName + ':' + p, this.id, Nohm.logError);
    }
    this.getClient().zadd(Nohm.prefix.scoredindex + this.modelName + ':' + p, this.properties[p].value, this.id, Nohm.logError);
  }
  if (this.__inDB) {
    this.getClient().srem(Nohm.prefix.index + this.modelName + ':' + p + ':' + this.properties[p].__oldValue, this.id, Nohm.logError);
  }
  this.getClient().sadd(Nohm.prefix.index + this.modelName + ':' + p + ':' + this.properties[p].value, this.id, Nohm.logError);
},

/**
 *  Update an existing dataset with the new values.
 */
exports.__update = function __update(all, callback) {
  var args = [Nohm.prefix.hash + this.modelName + ':' + this.id],
  props = this.properties,
  self = this,
  p,
  realUpdate;
  for (p in props) {
    if (all || props[p].__updated) {
      args.push(p);
      args.push(props[p].value);
    }
  }
  realUpdate = function realUpdate(err) {
    var id = 0, changeConductors = {},
    changeArray = [], p, cb,
    i, n, len,
    changeConductorArgs = [];
    if (!err) {
      for (p in props) {
        if (props.hasOwnProperty(p)) {
          // free old uniques
          if (props[p].unique === true && props[p].__updated) {
            if (self.__inDB) {
              self.getClient().del(Nohm.prefix.unique + self.modelName + ':' + p + ':' + props[p].__oldValue, Nohm.logError);
            }
          }
          if (props[p].index === true && (!self.__inDB || props[p].__updated)) {
            self.__index(p);
          }
          self.property(p, props[p].value || 0); // this ensures typecasing/behaviours
          props[p].__updated = false;
          props[p].__oldValue = props[p].value;
          self.errors[p] = [];
        }
      }
    }
    self.__inDB = true;
    if (typeof callback !== 'function' && err) {
      Nohm.logError('Nohm: Updating an object resulted in a client error: ' + err);
      throw err;
    } else if (err) {
      callback(err);
    } else {
      if (self.relationChanges.length > 0) {
        cb = function (change, callback) {
          self['__' + change.action](change.object, change.name, function () {
            change.callback(change.action,
                                self.modelName,
                                change.name,
                                change.object);
            callback();
          });
        };
        for (i = 0, n = i + 1, len = self.relationChanges.length; i < len; i = i + 1, n = i + 1) {
          id = numToAlpha(i);
          changeArray.push(id + '1');
          changeConductorArgs.push(self.relationChanges[i]);
          changeConductors[id] = ['_' + n, cb];
        }
        self.relationChanges = [];
        changeArray.push(callback);
        changeConductors.done = changeArray;
        new Conduct(changeConductors).apply(this, changeConductorArgs);
      } else {
        callback();
      }
    }
  };
  if (args.length > 1) {
    args.push(realUpdate);
    this.getClient().hmset.apply(this.getClient(), args);
  } else {
    realUpdate();
  }
},

/**
 *  Remove an objet from the database.
 *  Note: Does not destroy the js object or its properties itself!
 */
exports.remove = function remove(callback) {
  var self = this;
  
  if (!this.id) {
    callback('The object you are trying to delete has no id.');
  } else if (!this.__inDB) {
    this.load(this.id, function () {
      self.__realDelete(callback);
    });
  } else {
    this.__realDelete(callback);
  }
},

exports.__realDelete = function __realDelete(callback) {
  var self = this;
  // redis KEYS is slow. better solutions:
  // 1) add all relationkeys to a set when creating them, fetch those instead of client.KEYS
  this.getClient().keys(Nohm.prefix.relations + this.modelName + ':*:' + self.id,
           function (err, keys) {
            var r, i, n, len, conductorName,
            conductors = {}, conductorsDone = [], conductorArgs = [],
            inConductCallback, relationActions = [];
            if (err && typeof callback === 'function') {
              callback(err);
            } else if (err) {
              self.logError(err);
            }

            if (keys && Array.isArray(keys) && keys.length > 0) {
              keys = keys.toString().split(',');
              inConductCallback = function (key, callback) {
                relationActions.push(function (multi) {
                  multi.del(key);
                });
                self.getClient().smembers(key, function (err, value) {
                  var ids = value.toString().split(','), i, len,
                  relName, matches, namedMatches, objName,
                  sremFunc = function (key) {
                    return function (multi) {
                      multi.srem(key, self.id);
                    };
                  };
                  if (!err && value.toString() !== '') {
                    matches = key.match(/:([\w]*):([\w]*):[\d]+$/i);
                    if (matches[1] === 'child') {
                      relName = 'parent';
                    } else if (matches[1] === 'parent') {
                      relName = 'child';
                    } else {
                      namedMatches = matches[1].match(/^([\w]*)Parent$/);
                      if (namedMatches) {
                        relName = namedMatches[1];
                      } else {
                        relName = matches[1] + 'Parent';
                      }
                    }
                    objName = matches[2];
                    for (i = 0, len = ids.length; i < len; i = i + 1) {
                      relationActions.push(sremFunc(
                                  Nohm.prefix.relations + objName + ':' +
                                  relName + ':' + self.modelName +
                                  ':' + ids[i]));
                    }
                  }
                  callback();
                });
              };
              for (i = 0, n = i + 1, len = keys.length; i < len; i = i + 1, n = i + 1) {
                conductorArgs.push(keys[i]);
                conductorName = keys[i].replace(/[:\d]/ig, '');
                conductors[conductorName] = ['_' + n, inConductCallback];
                conductorsDone.push(conductorName + '0');
              }
            }

            conductorsDone.push(function () {
              var p, i, len, 
              multi = self.getClient().multi();

              multi.del(Nohm.prefix.hash + self.modelName + ':' + self.id);
              multi.srem(Nohm.prefix.idsets + self.modelName, self.id);

              for (p in self.properties) {
                if (self.properties.hasOwnProperty(p)) {
                  if (self.properties[p].unique) {
                    multi.del(Nohm.prefix.unique + self.modelName + ':' + p + ':' +
                              self.properties[p].__oldValue);
                  }
                  if (self.properties[p].index) {
                    multi.srem(Nohm.prefix.index + self.modelName + ':' + p + ':' +
                               self.properties[p].__oldValue,
                               self.id);
                  }
                  if (self.properties[p].__numericIndex) {
                    multi.zrem(Nohm.prefix.scoredindex + self.modelName + ':' + p,
                               self.id);
                  }
                }
              }

              len = relationActions.length;
              if (len > 0) {
                for (i = 0; i < len; i = i + 1) {
                  relationActions[i](multi);
                }
              }

              multi.exec(function (err, values) {
                self.id = 0;
                if (typeof callback === 'function') {
                  callback(err);
                } else {
                  Nohm.logError(err);
                }
              });
            });
            conductors.done = conductorsDone;
            new Conduct(conductors, 'done1').apply(this, conductorArgs);
          });
}
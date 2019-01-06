const crypto = require('crypto')
const moment = require('moment')
const EventEmitter = require('events')
const camelCase = require('camelcase')
const slugify = require('@sindresorhus/slugify')
const { cloneDeep, isObject } = require('lodash')
const { ISO_8601_FORMAT } = require('../utils/constants')
const { isResolvablePath } = require('../utils')
const { warn } = require('../utils/log')

const nonValidCharsRE = new RegExp('[^a-zA-Z0-9_]', 'g')
const leadingNumberRE = new RegExp('^([0-9])')

class ContentTypeCollection extends EventEmitter {
  constructor (store, pluginStore, options) {
    super()

    this.baseStore = store
    this.pluginStore = pluginStore

    this.options = { refs: {}, fields: {}, ...options }
    this.typeName = options.typeName
    this.description = options.description
    this.resolveAbsolutePaths = options.resolveAbsolutePaths || false

    this.collection = store.data.addCollection(options.typeName, {
      indices: ['id', 'path', 'date'],
      unique: ['id', 'path'],
      autoupdate: true
    })
  }

  addReference (fieldName, options) {
    this.options.refs[camelCase(fieldName)] = options
  }

  addSchemaField (fieldName, options) {
    this.options.fields[camelCase(fieldName)] = options
  }

  addNode (options) {
    const { node, belongsTo } = this.createNode(options)

    // add transformer to content type to let it
    // extend the node type when creating schema
    const { mimeTypes } = this.options
    const { mimeType } = node.internal
    if (mimeType && !mimeTypes.hasOwnProperty(mimeType)) {
      mimeTypes[mimeType] = this.pluginStore._transformers[mimeType]
    }

    try {
      this.baseStore.index.insert({
        type: 'node',
        path: node.path,
        typeName: node.typeName,
        uid: node.uid,
        id: node.id,
        belongsTo,
        _id: node.id // TODO: remove this before v1.0
      })
    } catch (err) {
      warn(`Skipping duplicate path for ${node.path}`, this.typeName)
      return null
    }

    this.collection.insert(node)
    this.emit('change', node)

    return node
  }

  getNode (id) {
    return this.collection.findOne({ id })
  }

  updateNode (id, options) {
    const node = this.getNode(id)
    const oldNode = cloneDeep(node)
    const indexEntry = this.baseStore.index.findOne({ uid: node.uid })
    const internal = this.createInternals(options.internal)

    Object.assign(node.internal, this.createInternals(options.internal))

    // transform content with transformer for given mime type
    if (internal.content && internal.mimeType) {
      this.transformNodeOptions(options, internal)
    }

    const { fields, belongsTo } = this.processNodeFields(options.fields, node.internal.origin)

    node.title = options.title || fields.title || node.title
    node.date = options.date || fields.date || node.date
    node.slug = options.slug || fields.slug || this.slugify(node.title)
    node.content = options.content || fields.content || node.content
    node.excerpt = options.excerpt || fields.excerpt || node.excerpt
    node.internal = Object.assign({}, node.internal, internal)
    node.path = typeof options.path === 'string'
      ? '/' + options.path.replace(/^\/+/g, '')
      : this.makePath(node)

    node.fields = fields
    indexEntry.path = node.path
    indexEntry.belongsTo = belongsTo

    this.emit('change', node, oldNode)

    return node
  }

  removeNode (id) {
    const node = this.collection.findOne({ id })

    this.baseStore.index.findAndRemove({ uid: node.uid })
    this.collection.findAndRemove({ id })

    this.emit('change', undefined, node)
  }

  createNode (options = {}) {
    const { typeName } = this.options
    const hash = crypto.createHash('md5')
    const internal = this.createInternals(options.internal)
    const id = options.id || options._id || this.makeUid(JSON.stringify(options))
    const node = { id, typeName, internal }

    // TODO: remove before 1.0
    node._id = id

    // transform content with transformer for given mime type
    if (internal.content && internal.mimeType) {
      this.transformNodeOptions(options, internal)
    }

    const { fields, belongsTo } = this.processNodeFields(options.fields, node.internal.origin)

    node.uid = hash.update(typeName + node.id).digest('hex')
    node.title = options.title || fields.title || node.id
    node.date = options.date || fields.date || new Date().toISOString()
    node.slug = options.slug || fields.slug || this.slugify(node.title)
    node.content = options.content || fields.content || ''
    node.excerpt = options.excerpt || fields.excerpt || ''
    node.withPath = typeof options.path === 'string'

    node.fields = fields
    node.path = typeof options.path === 'string'
      ? '/' + options.path.replace(/^\/+/g, '')
      : this.makePath(node)

    return { node, belongsTo }
  }

  createInternals (options = {}) {
    return {
      origin: options.origin,
      mimeType: options.mimeType,
      content: options.content,
      timestamp: Date.now()
    }
  }

  transformNodeOptions (options, internal) {
    const result = this.transform(internal)

    if (result.title) options.title = result.title
    if (result.slug) options.slug = result.slug
    if (result.path) options.path = result.path
    if (result.date) options.date = result.date
    if (result.content) options.content = result.content
    if (result.excerpt) options.excerpt = result.excerpt

    if (result.fields) {
      options.fields = Object.assign(options.fields || {}, result.fields)
    }
  }

  processNodeFields (input = {}, origin = '') {
    const belongsTo = {}

    const processRefField = ({ typeName, id }) => {
      belongsTo[typeName] = belongsTo[typeName] || {}
      if (Array.isArray(id)) id.forEach(id => (belongsTo[typeName][id] = true))
      else belongsTo[typeName][id] = true
    }

    const processField = field => {
      if (field === undefined) return field
      if (field === null) return field

      switch (typeof field) {
        case 'object':
          if (isRefField(field)) {
            if (Array.isArray(field.typeName)) {
              field.typeName.forEach(typeName => {
                processRefField({ typeName, id: field.id })
              })
            } else {
              processRefField(field)
            }
          }
          return processFields(field)
        case 'string':
          return isResolvablePath(field)
            ? this.resolveFilePath(origin, field)
            : field
      }

      return field
    }

    const createKey = key => {
      key = key.replace(nonValidCharsRE, '_')
      key = camelCase(key)
      key = key.replace(leadingNumberRE, '_$1')

      return key
    }

    const processFields = fields => {
      const res = {}

      for (const key in fields) {
        if (key.startsWith('__')) {
          // don't touch keys which starts with __ because they are
          // meant for internal use and will not be part of the schema
          res[key] = fields[key]
          continue
        }

        res[createKey(key)] = Array.isArray(fields[key])
          ? fields[key].map(value => processField(value))
          : processField(fields[key])
      }

      return res
    }

    const fields = processFields(input)

    // TODO: this should be removed before 1.0
    for (const fieldName in this.options.refs) {
      const id = fields[fieldName]
      const { typeName } = this.options.refs[fieldName]
      processRefField({ id, typeName })
    }

    return { fields, belongsTo }
  }

  resolveFilePath (...args) {
    return this.pluginStore._app.resolveFilePath(...args, this.resolveAbsolutePaths)
  }

  makePath (node) {
    const date = moment.utc(node.date, ISO_8601_FORMAT, true)
    const { routeKeys } = this.options
    const params = {}

    // Use root level fields as route params. Primitive values
    // are slugified but the original value will be available
    // with '_raw' suffix.
    for (let i = 0, l = routeKeys.length; i < l; i++) {
      const keyName = routeKeys[i]
      const fieldValue = node.fields[keyName] || node[keyName] || keyName

      if (keyName === 'year') params.year = date.format('YYYY')
      else if (keyName === 'month') params.month = date.format('MM')
      else if (keyName === 'day') params.day = date.format('DD')
      else if (
        isObject(fieldValue) &&
        fieldValue.hasOwnProperty('typeName') &&
        fieldValue.hasOwnProperty('id') &&
        !Array.isArray(fieldValue.id)
      ) {
        params[keyName] = String(fieldValue.id)
      } else if (!isObject(fieldValue) && !params[keyName]) {
        params[keyName] = this.slugify(String(fieldValue))
        params[keyName + '_raw'] = String(fieldValue)
      }
    }

    return this.options.makePath(params)
  }

  makeUid (orgId) {
    return crypto.createHash('md5').update(orgId).digest('hex')
  }

  slugify (string = '') {
    return slugify(string, { separator: '-' })
  }

  transform ({ mimeType, content }, options) {
    const transformer = this.pluginStore._transformers[mimeType]

    if (!transformer) {
      throw new Error(`No transformer for ${mimeType} is installed.`)
    }

    return transformer.parse(content, options)
  }
}

function isRefField (field) {
  return (
    typeof field === 'object' &&
    Object.keys(field).length === 2 &&
    field.hasOwnProperty('typeName') &&
    field.hasOwnProperty('id')
  )
}

module.exports = ContentTypeCollection

const camelCase = require('camelcase')
const { mapValues } = require('lodash')
const { isDate, dateType } = require('./types/date')

const {
  GraphQLInt,
  GraphQLList,
  GraphQLFloat,
  GraphQLString,
  GraphQLBoolean,
  GraphQLObjectType
} = require('../graphql')

function inferTypes (nodes, nodeType) {
  const fields = {}
  let node, type

  for (let i = 0, l = nodes.length; i < l; i++) {
    node = nodes[i]

    for (const key in node.fields) {
      if ((type = inferType(node.fields[key], key, nodeType))) {
        fields[key] = type
      }
    }
  }

  return fields
}

function inferType (value, key, nodeType) {
  if (!value) return null

  if (Array.isArray(value)) {
    const type = inferType(value[0], key, nodeType)
    return type ? {
      type: new GraphQLList(type.type),
      resolve: (fields, args, context, { fieldName }) => {
        const value = fields[fieldName]
        return Array.isArray(value) ? value : []
      }
    } : null
  }

  const type = typeof value

  if (isDate(value)) {
    return dateType
  }

  switch (type) {
    case 'string':
      return { type: GraphQLString }
    case 'boolean':
      return { type: GraphQLBoolean }
    case 'number':
      return { type: is32BitInt(value) ? GraphQLInt : GraphQLFloat }
    case 'object':
      return createObjectType(value, key, nodeType)
    default:
      return null
  }
}

function createObjectType (obj, key, nodeType) {
  const name = createTypeName(nodeType, key)
  const fields = mapValues(obj, (value, key) => inferType(value, key, name))
  const resolve = obj => obj

  return {
    type: new GraphQLObjectType({ name, fields, resolve })
  }
}

function createTypeName (nodeType, key) {
  return camelCase(`${nodeType} ${key}`, { pascalCase: true })
}

function is32BitInt (x) {
  return (x | 0) === x
}

module.exports = {
  inferTypes,
  inferType
}

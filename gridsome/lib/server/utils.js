const fs = require('fs')
const url = require('url')
const chalk = require('chalk')
const address = require('address')

const isUnspecifiedHost = host => host === '0.0.0.0' || host === '::'

// https://stackoverflow.com/a/20012536
const isInContainer = () => {
  const content = fs.existsSync('/proc/1/cgroup')
    ? fs.readFileSync('/proc/1/cgroup', 'utf-8')
    : ''

  return /:\/(lxc|docker|kubepods)\//.test(content)
}

const formatUrl = (hostname, port, useHttps, pathname = '/') => {
  if (isUnspecifiedHost(hostname)) hostname = 'localhost'

  return url.format({
    protocol: useHttps ? 'https' : 'http',
    hostname,
    port,
    pathname
  })
}

const formatPrettyUrl = (hostname, port, useHttps, pathname = '/') => {
  if (isUnspecifiedHost(hostname)) hostname = 'localhost'

  return url.format({
    protocol: useHttps ? 'https' : 'http',
    hostname,
    port: chalk.bold(port),
    pathname
  })
}

const prepareUrls = (hostname, port, useHttps) => {
  const lan = { ip: undefined, pretty: undefined }

  if (isUnspecifiedHost(hostname) && !isInContainer()) {
    lan.ip = address.ip() || ''
    // https://en.wikipedia.org/wiki/Private_network#Private_IPv4_address_spaces
    if (/^10[.]|^172[.](1[6-9]|2[0-9]|3[0-1])[.]|^192[.]168[.]/.test(lan.ip)) {
      lan.pretty = formatPrettyUrl(lan.ip, port, useHttps)
    }
  }

  const local = {
    url: formatUrl(hostname, port, useHttps),
    pretty: formatPrettyUrl(hostname, port, useHttps)
  }

  const explore = {
    endpoint: '/___explore',
    pretty: formatPrettyUrl(hostname, port, useHttps, '/___explore')
  }

  const graphql = {
    endpoint: '/___graphql',
    pretty: formatPrettyUrl(hostname, port, useHttps, '/___graphql')
  }

  const sockjs = {
    endpoint: '/___echo',
    pretty: formatPrettyUrl(hostname, port, useHttps, '/___echo')
  }

  if (process.env.GRAPHQL_ENDPOINT) {
    graphql.endpoint = process.env.GRAPHQL_ENDPOINT
    graphql.pretty = formatPrettyUrl(hostname, port, useHttps, graphql.endpoint)
  }

  if (process.env.SOCKJS_ENDPOINT) {
    sockjs.endpoint = process.env.SOCKJS_ENDPOINT
    graphql.pretty = formatPrettyUrl(hostname, port, useHttps, sockjs.endpoint)
  }

  return {
    lan,
    local,
    graphql,
    explore,
    sockjs
  }
}

module.exports = {
  formatUrl,
  formatPrettyUrl,
  prepareUrls
}

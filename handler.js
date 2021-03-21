'use strict';

exports.main = (event, context, callback) => {

  const cf = event.Records[0].cf;
  const request = cf.request;
  const hostname = request.headers.host[0].value;

  const redirectEnabled = '[REDIRECT_ENABLED]' === 'true';
  const basicAuthEnabled = '[BASIC_AUTH_ENABLED]' === 'true';

  if (redirectEnabled && hostname === '[REDIRECT_FROM]') {
    const response = {
      status: '302',
      statusDescription: 'Found',
      headers: {
        location: [{
          key: 'Location',
          value: '[REDIRECT_TO]',
        }],
      },
    };
    callback(null, response);
    return;
  }

  if (basicAuthEnabled) {
    const authUser = '[BASIC_AUTH_USERNAME]';
    const authPass = '[BASIC_AUTH_PASSWORD]';
    const request = event.Records[0].cf.request;
    const headers = request.headers;
    const authString = 'Basic ' + new Buffer(authUser + ':' + authPass).toString('base64');
    if (typeof headers.authorization == 'undefined' || headers.authorization[0].value != authString) {
      callback(null, {
        status: '401',
        statusDescription: 'Unauthorized',
        body: 'Unauthorized',
        headers: {
          'www-authenticate': [{key: 'WWW-Authenticate', value:'Basic'}],
        }
      });
      return;
    }
  }

  callback(null, request);

};
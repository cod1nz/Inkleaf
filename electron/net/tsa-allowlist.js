'use strict';

/**
 * Fixed RFC 3161 timestamp authorities. The renderer sends only an id; a URL never comes from it.
 * Hosts mirror src/js/config/timestamp-tsa.ts. https is used where the provider's TLS endpoint was verified
 * to work (sectigo, freetsa). digicert (https times out), ssl.com (certificate name mismatch) and mesign stay on
 * plain http as listed: the timestamp token is signed at the application layer and only a hash is sent.
 */
const TSA = Object.freeze({
  digicert: Object.freeze({
    label: 'DigiCert',
    url: 'http://timestamp.digicert.com',
  }),
  sectigo: Object.freeze({
    label: 'Sectigo',
    url: 'https://timestamp.sectigo.com',
  }),
  sslcom: Object.freeze({ label: 'SSL.com', url: 'http://ts.ssl.com' }),
  freetsa: Object.freeze({ label: 'FreeTSA', url: 'https://freetsa.org/tsr' }),
  mesign: Object.freeze({ label: 'MeSign', url: 'http://tsa.mesign.com' }),
});

function getTsa(id) {
  if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(TSA, id))
    return null;
  return TSA[id];
}

module.exports = { TSA, getTsa };

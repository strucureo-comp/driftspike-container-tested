const cors = require('cors');
const crypto = require('crypto');
const dns = require('dns').promises;
const { execFile } = require('child_process');
const express = require('express');
const fs = require('fs');
const path = require('path');
const util = require('util');

const execFileAsync = util.promisify(execFile);

const app = express();
const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json());

const DEFAULTS = {
  domain: process.env.MAIL_DOMAIN || 'example.com',
  mailHost: process.env.MAIL_HOST || 'mail',
  ip: process.env.SERVER_IP || '192.0.2.50',
  adminEmail: process.env.POSTMASTER_ADDRESS || 'postmaster@example.com'
};

const keyCache = new Map();
const nsCache = new Map();
const verificationCache = new Map();
const DKIM_STORE_PATH = path.join(__dirname, '..', 'config', 'dkim-store.json');
const USERS_STORE_PATH = path.join(__dirname, '..', 'config', 'mail-users.json');
const MAILSERVER_CONTAINER = process.env.MAILSERVER_CONTAINER || 'mailserver';
loadStoredKeys();

function loadStoredKeys() {
  try {
    const file = fs.readFileSync(DKIM_STORE_PATH, 'utf8');
    const parsed = JSON.parse(file);
    for (const [cacheKey, pair] of Object.entries(parsed)) {
      keyCache.set(cacheKey, pair);
    }
  } catch {
    // Missing store is fine on first boot.
  }
}

function persistKeys() {
  const serializable = Object.fromEntries(keyCache.entries());
  fs.mkdirSync(path.dirname(DKIM_STORE_PATH), { recursive: true });
  fs.writeFileSync(DKIM_STORE_PATH, JSON.stringify(serializable, null, 2));
}

function loadUsers() {
  try {
    const file = fs.readFileSync(USERS_STORE_PATH, 'utf8');
    return JSON.parse(file);
  } catch {
    return [];
  }
}

function persistUsers(users) {
  fs.mkdirSync(path.dirname(USERS_STORE_PATH), { recursive: true });
  fs.writeFileSync(USERS_STORE_PATH, JSON.stringify(users, null, 2));
}

function buildDkimKeyPair(cacheKey) {
  if (keyCache.has(cacheKey)) {
    return keyCache.get(cacheKey);
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const trimmed = publicKey
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '')
    .trim();

  const pair = { publicKey: trimmed, privateKey };
  keyCache.set(cacheKey, pair);
  persistKeys();
  return pair;
}

function buildDockerCompose(domain, mailHost, adminEmail) {
  return `version: "3.9"
services:
  mail:
    image: docker.io/mailserver/docker-mailserver:latest
    hostname: ${mailHost}
    domainname: ${domain}
    container_name: mailserver
    env_file:
      - ./mailserver.env
    volumes:
      - ./config:/tmp/docker-mailserver
      - maildata:/var/mail
      - mailstate:/var/mail-state
      - ./logs:/var/log/mail
    ports:
      - 25:25
      - 143:143
      - 587:587
      - 993:993
    restart: unless-stopped

volumes:
  maildata:
  mailstate:`;
}

function buildQuickSteps(domain) {
  return [
    `Drop ${domain} into your Vercel / DNS dashboard and add the records listed above.`,
    'Deploy docker-mailserver with the compose template and the `.env` file we generate below.',
    'Test SMTP with `openssl s_client -connect mail.YOUR_DOMAIN:587 -starttls smtp` and verify DKIM/DMARC with `dig`.'
  ];
}

function normalizeTextValue(value) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeDomain(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '');
}

function normalizeEmail(value) {
  return value.trim().toLowerCase();
}

function buildAutomaticAliases(localPart, domain) {
  const suggestions = {
    admin: ['postmaster', 'hostmaster', 'webmaster'],
    support: ['help'],
    info: ['hello'],
    hello: ['hi'],
    sales: ['billing']
  };

  const generated = suggestions[localPart] || [];
  return generated.map((alias) => `${alias}@${domain}`);
}

function buildVerificationCacheKey(domain, mailHost, ip, adminEmail, selector) {
  return [domain, mailHost, ip, adminEmail, selector].join('|');
}

function buildUserCommands(user) {
  return {
    create: `docker exec mailserver setup email add ${user.email} '${user.password}'`,
    updatePassword: `docker exec mailserver setup email update ${user.email} '${user.password}'`,
    remove: `docker exec mailserver setup email del ${user.email}`
  };
}

function shapeUser(user) {
  return {
    ...user,
    commands: buildUserCommands(user)
  };
}

async function reconcileUsers(users) {
  let changed = false;

  for (const user of users) {
    if (!user.provision?.applied && String(user.provision?.mode || '').startsWith('pending')) {
      const result = await runMailserverCommand(['email', 'add', user.email, user.password]);

      if (result.applied || result.mode !== user.provision?.mode || result.output !== user.provision?.output) {
        user.provision = result;
        user.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
  }

  if (changed) {
    persistUsers(users);
  }

  return users;
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

async function runMailserverCommand(args) {
  try {
    const commandsToTry = [
      ['docker', ['exec', MAILSERVER_CONTAINER, 'setup', ...args]],
      ['sudo', ['-n', 'docker', 'exec', MAILSERVER_CONTAINER, 'setup', ...args]]
    ];

    for (const [command, commandArgs] of commandsToTry) {
      try {
        const result = await execFileAsync(command, commandArgs, {
          timeout: 12000,
          maxBuffer: 1024 * 1024
        });

        return {
          applied: true,
          mode: command === 'docker' ? 'docker' : 'sudo-docker',
          output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
        };
      } catch (innerError) {
        const output = [innerError.stdout, innerError.stderr, innerError.message].filter(Boolean).join('\n').trim();
        const missingBinary = innerError.code === 'ENOENT';
        const permissionIssue = output.toLowerCase().includes('permission denied');
        const missingContainer = output.toLowerCase().includes('no such container');

        if (missingContainer) {
          return {
            applied: false,
            mode: 'pending-mailserver-unavailable',
            output
          };
        }

        if (!missingBinary && !permissionIssue) {
          return {
            applied: false,
            mode: 'pending-mailserver-unavailable',
            output
          };
        }
      }
    }

    return {
      applied: false,
      mode: 'pending-docker-missing',
      output: 'Docker is not available to the backend process'
    };
  } catch (error) {
    const missingDocker = error.code === 'ENOENT';
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n').trim();

    return {
      applied: false,
      mode: missingDocker ? 'pending-docker-missing' : 'pending-mailserver-unavailable',
      output
    };
  }
}

async function getAuthoritativeResolver(domain) {
  if (nsCache.has(domain)) {
    return nsCache.get(domain);
  }

  const labels = domain.split('.');
  for (let index = 0; index < labels.length; index += 1) {
    const candidate = labels.slice(index).join('.');

    try {
      const nameservers = await dns.resolveNs(candidate);
      if (nameservers.length > 0) {
        const serverIps = [];

        for (const nameserver of nameservers) {
          try {
            const [ipv4] = await dns.resolve4(nameserver);
            if (ipv4) {
              serverIps.push(ipv4);
            }
          } catch {
            // Skip nameserver if we cannot resolve its IP.
          }
        }

        if (serverIps.length === 0) {
          continue;
        }

        const resolver = new dns.Resolver();
        resolver.setServers(serverIps);
        nsCache.set(domain, resolver);
        return resolver;
      }
    } catch {
      // Keep walking up the domain until NS is found.
    }
  }

  return dns;
}

function buildSetup(domain, mailHost, ip, adminEmail, selector) {
  const keyPair = buildDkimKeyPair(`${domain}:${selector}`);
  const dnsRecords = [
    {
      type: 'A',
      name: `${mailHost}`,
      fqdn: `${mailHost}.${domain}`,
      host: `${mailHost}`,
      value: ip,
      answer: ip,
      ttl: 300,
      note: 'Point the mail subdomain to this server',
      providerHint: 'Create an A record with host `mail` and value equal to your public server IP.'
    },
    {
      type: 'MX',
      name: '@',
      fqdn: domain,
      host: '@',
      priority: 10,
      value: `${mailHost}.${domain}.`,
      answer: `${mailHost}.${domain}`,
      ttl: 600,
      note: 'Primary MX record',
      providerHint: 'Create an MX record with host `@`, mail server `mail.yourdomain.com`, and priority `10`. Do not paste SPF text into this field.'
    },
    {
      type: 'TXT',
      name: '@',
      fqdn: domain,
      host: '@',
      value: 'v=spf1 mx -all',
      answer: 'v=spf1 mx -all',
      ttl: 600,
      note: 'SPF limited to this MX host',
      providerHint: 'Create a TXT record with host `@`. Paste the SPF string exactly as shown.'
    },
    {
      type: 'TXT',
      name: `_dmarc`,
      fqdn: `_dmarc.${domain}`,
      host: '_dmarc',
      value: `v=DMARC1; p=quarantine; rua=mailto:${adminEmail}; ruf=mailto:${adminEmail}; adkim=s; aspf=s`,
      answer: `v=DMARC1; p=quarantine; rua=mailto:${adminEmail}; ruf=mailto:${adminEmail}; adkim=s; aspf=s`,
      ttl: 600,
      note: 'Collect DMARC reports while quarantining suspicious traffic'
    },
    {
      type: 'TXT',
      name: `${selector}._domainkey`,
      fqdn: `${selector}._domainkey.${domain}`,
      host: `${selector}._domainkey`,
      value: `v=DKIM1; k=rsa; p=${keyPair.publicKey}`,
      answer: `v=DKIM1; k=rsa; p=${keyPair.publicKey}`,
      ttl: 600,
      note: 'DKIM public key; keep private key secret in docker-mailserver config'
    },
    {
      type: 'CAA',
      name: '@',
      fqdn: domain,
      host: '@',
      value: '0 issue "letsencrypt.org"',
      answer: '0 issue "letsencrypt.org"',
      ttl: 86400,
      note: 'CAA allows Let’s Encrypt to issue certs for the mail host'
    }
  ];

  return {
    domain,
    mailHost,
    adminEmail,
    ip,
    selector,
    dockerCompose: buildDockerCompose(domain, mailHost, adminEmail),
    dnsRecords,
    dkimPrivateKey: keyPair.privateKey,
    quickSteps: buildQuickSteps(domain),
    connectionDetails: {
      smtp: {
        host: `${mailHost}.${domain}`,
        port: 587,
        security: 'STARTTLS',
        usernameHint: adminEmail
      },
      imap: {
        host: `${mailHost}.${domain}`,
        port: 993,
        security: 'SSL/TLS',
        usernameHint: adminEmail
      }
    }
  };
}

async function checkRecord(record, resolver) {
  try {
    if (record.type === 'A') {
      const addresses = await resolver.resolve4(record.fqdn);
      const status = addresses.includes(record.value) ? 'connected' : 'mismatch';
      return {
        ...record,
        status,
        actual: addresses.join(', ') || 'No A record found'
      };
    }

    if (record.type === 'MX') {
      const exchanges = await resolver.resolveMx(record.fqdn);
      const expected = `${record.priority} ${record.answer.toLowerCase().replace(/\.$/, '')}`;
      const actualValues = exchanges
        .sort((left, right) => left.priority - right.priority)
        .map((entry) => `${entry.priority} ${entry.exchange.toLowerCase().replace(/\.$/, '')}`);
      const status = actualValues.includes(expected) ? 'connected' : 'mismatch';
      return {
        ...record,
        status,
        actual: actualValues.join(' | ') || 'No MX record found'
      };
    }

    if (record.type === 'CAA' && typeof dns.resolveCaa === 'function') {
      const caaRecords = await resolver.resolveCaa(record.fqdn);
      const actualValues = caaRecords.map((entry) => {
        if (entry.issue) {
          return `${entry.critical || 0} issue "${entry.issue}"`;
        }

        if (entry.issuewild) {
          return `${entry.critical || 0} issuewild "${entry.issuewild}"`;
        }

        if (entry.iodef) {
          return `${entry.critical || 0} iodef "${entry.iodef}"`;
        }

        return `${entry.critical || 0} unknown ""`;
      });
      const status = actualValues.map(normalizeTextValue).includes(normalizeTextValue(record.answer)) ? 'connected' : 'mismatch';
      return {
        ...record,
        status,
        actual: actualValues.join(' | ') || 'No CAA record found'
      };
    }

    const txtChunks = await resolver.resolveTxt(record.fqdn);
    const actualValues = txtChunks.map((parts) => parts.join(''));
    const expected = normalizeTextValue(record.answer);
    const actualNormalized = actualValues.map(normalizeTextValue);
    const status = actualNormalized.includes(expected) ? 'connected' : 'mismatch';

    return {
      ...record,
      status,
      actual: actualValues.join(' | ') || 'No TXT record found'
    };
  } catch (error) {
    if (error.code === 'ENOTFOUND' || error.code === 'ENODATA' || error.code === 'ENOTIMP' || error.code === 'SERVFAIL') {
      return {
        ...record,
        status: 'missing',
        actual: 'No matching DNS record found'
      };
    }

    return {
      ...record,
      status: 'error',
      actual: error.message
    };
  }
}

async function verifyDomain(domain, mailHost, ip, adminEmail, selector) {
  const cacheKey = buildVerificationCacheKey(domain, mailHost, ip, adminEmail, selector);
  const cached = verificationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }

  const setup = buildSetup(domain, mailHost, ip, adminEmail, selector);
  const resolver = await getAuthoritativeResolver(domain);
  const checks = await Promise.all(setup.dnsRecords.map((record) => checkRecord(record, resolver)));
  const coreStatuses = checks
    .filter((record) => ['A', 'MX'].includes(record.type) || record.name === '@' || record.name === '_dmarc')
    .map((record) => record.status);
  const ready = coreStatuses.length > 0 && coreStatuses.every((status) => status === 'connected');
  const payload = {
    domain,
    ready,
    checks,
    connectionDetails: setup.connectionDetails
  };

  verificationCache.set(cacheKey, {
    expiresAt: Date.now() + 15000,
    payload
  });

  return payload;
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/setup', (req, res) => {
  const domain = (req.query.domain || DEFAULTS.domain).toLowerCase();
  const mailHost = req.query.mailHost || DEFAULTS.mailHost;
  const ip = req.query.ip || DEFAULTS.ip;
  const adminEmail = req.query.adminEmail || DEFAULTS.adminEmail;
  const selector = req.query.selector || 'mail';
  res.json(buildSetup(domain, mailHost, ip, adminEmail, selector));
});

app.get('/api/verify', asyncHandler(async (req, res) => {
  const domain = (req.query.domain || DEFAULTS.domain).toLowerCase();
  const mailHost = req.query.mailHost || DEFAULTS.mailHost;
  const ip = req.query.ip || DEFAULTS.ip;
  const adminEmail = req.query.adminEmail || DEFAULTS.adminEmail;
  const selector = req.query.selector || 'mail';
  res.json(await verifyDomain(domain, mailHost, ip, adminEmail, selector));
}));

app.get('/api/domain-overview', asyncHandler(async (req, res) => {
  const domain = (req.query.domain || DEFAULTS.domain).toLowerCase();
  const mailHost = req.query.mailHost || DEFAULTS.mailHost;
  const ip = req.query.ip || DEFAULTS.ip;
  const adminEmail = req.query.adminEmail || DEFAULTS.adminEmail;
  const selector = req.query.selector || 'mail';

  const setup = buildSetup(domain, mailHost, ip, adminEmail, selector);
  const verification = await verifyDomain(domain, mailHost, ip, adminEmail, selector);

  res.json({
    setup,
    verification
  });
}));

app.get('/api/admin/users', asyncHandler(async (req, res) => {
  const domain = normalizeDomain((req.query.domain || DEFAULTS.domain).toLowerCase());
  const users = await reconcileUsers(loadUsers());
  const filtered = users
    .filter((user) => user.domain === domain)
    .map(shapeUser);

  res.json({
    domain,
    users: filtered
  });
}));

app.post('/api/admin/users', asyncHandler(async (req, res) => {
  const domain = normalizeDomain((req.body.domain || DEFAULTS.domain).toLowerCase());
  const localPart = String(req.body.localPart || '').trim().toLowerCase();
  const password = String(req.body.password || '').trim();
  const quotaMb = Number(req.body.quotaMb || 1024);
  const aliases = Array.isArray(req.body.aliases)
    ? req.body.aliases.map((alias) => normalizeEmail(String(alias))).filter(Boolean)
    : buildAutomaticAliases(localPart, domain);

  if (!domain || !domain.includes('.')) {
    return res.status(400).json({ error: 'Valid domain is required.' });
  }

  if (!localPart || /[^a-z0-9._-]/i.test(localPart)) {
    return res.status(400).json({ error: 'A valid local part is required.' });
  }

  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const email = `${localPart}@${domain}`;
  const users = loadUsers();

  if (users.some((user) => user.email === email)) {
    return res.status(409).json({ error: 'Mailbox already exists.' });
  }

  const user = {
    domain,
    email,
    localPart,
    password,
    quotaMb,
    aliases,
    enabled: true,
    createdAt: new Date().toISOString(),
    provision: {
      applied: false,
      mode: 'pending',
      output: ''
    }
  };

  user.provision = await runMailserverCommand(['email', 'add', user.email, user.password]);

  users.push(user);
  persistUsers(users);

  return res.status(201).json(shapeUser(user));
}));

app.patch('/api/admin/users/:email', asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.params.email);
  const users = loadUsers();
  const index = users.findIndex((user) => user.email === email);

  if (index === -1) {
    return res.status(404).json({ error: 'Mailbox not found.' });
  }

  let shouldUpdatePassword = false;

  if (typeof req.body.password === 'string' && req.body.password.trim().length >= 8) {
    users[index].password = req.body.password.trim();
    shouldUpdatePassword = true;
  }

  if (typeof req.body.enabled === 'boolean') {
    users[index].enabled = req.body.enabled;
  }

  if (typeof req.body.quotaMb !== 'undefined') {
    users[index].quotaMb = Number(req.body.quotaMb || users[index].quotaMb);
  }

  if (Array.isArray(req.body.aliases)) {
    users[index].aliases = req.body.aliases.map((alias) => normalizeEmail(String(alias))).filter(Boolean);
  }

  if (shouldUpdatePassword) {
    users[index].provision = await runMailserverCommand(['email', 'update', users[index].email, users[index].password]);
  }

  users[index].updatedAt = new Date().toISOString();
  persistUsers(users);
  return res.json(shapeUser(users[index]));
}));

app.delete('/api/admin/users/:email', asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.params.email);
  const users = loadUsers();
  const user = users.find((entry) => entry.email === email);

  if (!user) {
    return res.status(404).json({ error: 'Mailbox not found.' });
  }

  await runMailserverCommand(['email', 'del', user.email]);

  const nextUsers = users.filter((entry) => entry.email !== email);
  persistUsers(nextUsers);
  return res.json({ removed: email });
}));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    error: 'Internal server error',
    details: error.message
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Mail server configurator listening on http://${HOST}:${PORT}`);
});

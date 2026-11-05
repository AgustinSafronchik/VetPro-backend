const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const jwt = require('jsonwebtoken');

const root = path.resolve(__dirname, '../.tmp');
fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'auth-test-'));
fs.writeFileSync(path.join(directory, 'test.db'), '');
process.env.DATABASE_URL = `file:${path.join(directory, 'test.db').replaceAll('\\', '/')}`;
process.env.JWT_SECRET = randomBytes(32).toString('hex');
const { app, prisma } = require('../dist/index');
const { hashPassword, verifyPassword } = require('../dist/passwords');
let server, base, admin, client, other, token, adminToken;
const password = 'Prueba-segura-123';

async function call(route, { method = 'GET', token, body } = {}) {
  const response = await fetch(base + route, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
async function login(email, value = password) {
  return call('/api/sessions', { method: 'POST', body: { email, password: value } });
}

before(async () => {
  execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate'], {
    cwd: path.resolve(__dirname, '..'), env: process.env, stdio: 'pipe',
  });
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await prisma.usuario.create({ data: { nombre: 'Admin', email: 'admin@test.invalid', passwordHash: await hashPassword(password), role: 'ADMIN', telefono: '123' } });
  adminToken = (await login(admin.email)).body.accessToken;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await prisma.$disconnect();
  // Solo elimina el directorio temporal creado por esta prueba.
  if (path.dirname(path.resolve(directory)) !== root) throw new Error('Ruta temporal no válida');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('registro guarda Argon2id con salt y login emite JWT de dos horas sin secretos', async () => {
  for (const email of ['client@test.invalid', 'other@test.invalid']) {
    const result = await call('/api/users', { method: 'POST', body: { nombre: 'Cliente', email, password, telefono: '123', role: 'ADMIN' } });
    assert.equal(result.status, 201);
    assert.equal(result.body.password, undefined);
    assert.equal(result.body.passwordHash, undefined);
  }
  client = await prisma.usuario.findUnique({ where: { email: 'client@test.invalid' } });
  other = await prisma.usuario.findUnique({ where: { email: 'other@test.invalid' } });
  assert.equal(client.role, 'USER');
  assert.match(client.passwordHash, /^\$argon2id\$/);
  assert.notEqual(client.passwordHash, other.passwordHash);
  assert.equal(await verifyPassword(client.passwordHash, password), true);
  assert.equal(await verifyPassword('texto-plano', 'texto-plano'), false);
  const logged = await login(' CLIENT@TEST.INVALID ');
  assert.equal(logged.status, 200);
  token = logged.body.accessToken;
  const claims = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'vetpro', audience: 'vetpro-app' });
  assert.equal(claims.sub, String(client.id));
  assert.equal(claims.exp - claims.iat, 7200);
  assert.equal(claims.sessionVersion, 0);
  assert.equal(logged.body.mustChangePassword, false);
  assert.equal(claims.password, undefined);
  assert.equal(claims.role, undefined);
  assert.equal((await login(client.email, 'incorrecta')).status, 401);
  assert.deepEqual((await login('missing@test.invalid')).body, (await login(client.email, 'incorrecta')).body);
});

test('todas las rutas privadas exigen sesión antes de validar el recurso', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
  const publicRoutes = new Set(['get /api/health', 'post /api/users', 'post /api/sessions', 'post /api/password-reset/request']);
  for (const [, method, route] of source.matchAll(/app\.(get|post|patch|delete)\('([^']+)'/g)) {
    if (publicRoutes.has(`${method} ${route}`)) continue;
    const result = await call(route.replace(':id', String(client.id)), { method: method.toUpperCase() });
    assert.equal(result.status, 401, `${method} ${route}`);
  }
});

test('rechaza tokens alterados, vencidos, de otra firma, algoritmo o destinatario', async () => {
  const options = { algorithm: 'HS256', subject: String(client.id), issuer: 'vetpro', audience: 'vetpro-app', expiresIn: '2h' };
  const badTokens = [
    `${client.id}.${'a'.repeat(64)}`,
    token.slice(0, -5) + 'xxxxx',
    jwt.sign({ sessionVersion: 0 }, process.env.JWT_SECRET, { ...options, expiresIn: -1 }),
    jwt.sign({ sessionVersion: 0 }, 'otra-clave', options),
    jwt.sign({ sessionVersion: 0 }, process.env.JWT_SECRET, { ...options, algorithm: 'HS384' }),
    jwt.sign({ sessionVersion: 0 }, process.env.JWT_SECRET, { ...options, audience: 'otra-app' }),
    jwt.sign({ sessionVersion: 0 }, process.env.JWT_SECRET, { algorithm: 'HS256', subject: String(client.id), issuer: 'vetpro', audience: 'vetpro-app' }),
  ];
  for (const invalid of badTokens) assert.equal((await call('/api/mascotas', { token: invalid })).status, 401);
});

test('rol actual y pertenencia se comprueban en el servidor', async () => {
  assert.equal((await call('/api/admin/users', { token })).status, 403);
  assert.equal((await call('/api/admin/users', { token: adminToken })).status, 200);
  const own = await call('/api/mascotas', { method: 'POST', token, body: { nombre: 'Luna', especie: 'Gato', fechaNacimiento: '2020-01-01', userId: other.id } });
  assert.equal(own.status, 201);
  assert.equal(own.body.userId, client.id);
  const foreign = await prisma.mascota.create({ data: { nombre: 'Ajena', especie: 'Perro', fechaNacimiento: '2020-01-01', userId: other.id } });
  const listed = await call(`/api/mascotas?userId=${other.id}`, { token });
  assert.deepEqual(listed.body.map(p => p.id), [own.body.id]);
  assert.equal((await call(`/api/mascotas/${foreign.id}`, { method: 'PATCH', token, body: { nombre: 'Cambio', userId: other.id } })).status, 404);
  assert.equal((await call(`/api/mascotas/${foreign.id}`, { method: 'DELETE', token })).status, 404);
  assert.equal((await call(`/api/users/${other.id}`, { token })).status, 403);
  await prisma.usuario.update({ where: { id: admin.id }, data: { role: 'USER' } });
  assert.equal((await call('/api/admin/users', { token: adminToken })).status, 403);
  await prisma.usuario.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
});

test('turno completo usa el dueño del JWT, conserva relaciones y rechaza duplicados', async () => {
  await prisma.sede.create({ data: { nombre: 'Prueba', direccion: 'Calle 1', dias: JSON.stringify(['lun','mar','mie','jue','vie','sab','dom']), horaDesde: '08:00', horaHasta: '18:00' } });
  const own = await prisma.mascota.findFirst({ where: { userId: client.id } });
  const foreign = await prisma.mascota.findFirst({ where: { userId: other.id } });
  const future = new Date(); future.setDate(future.getDate() + 2);
  const fecha = `${future.getFullYear()}-${String(future.getMonth()+1).padStart(2,'0')}-${String(future.getDate()).padStart(2,'0')}`;
  const body = { mascotaId: own.id, tipo: 'Control', sede: 'Prueba', fecha, hora: '10:00' };
  assert.equal((await call('/api/turnos', { method: 'POST', token, body: { ...body, mascotaId: foreign.id } })).status, 404);
  const created = await call('/api/turnos', { method: 'POST', token, body });
  assert.equal(created.status, 201);
  assert.equal(created.body.userId, client.id);
  assert.equal(created.body.mascota.id, own.id);
  assert.equal((await prisma.turno.findUnique({ where: { id: created.body.id } })).userId, client.id);
  assert.equal((await call('/api/turnos', { method: 'POST', token, body })).status, 409);
  assert.equal((await call('/api/turnos', { token })).body.length, 1);
});

test('cambiar contraseña invalida las sesiones anteriores y emite una nueva', async () => {
  const second = (await login(client.email)).body.accessToken;
  const result = await call(`/api/users/${client.id}/password`, { method: 'PATCH', token, body: { currentPassword: password, newPassword: 'Nueva-segura-456' } });
  assert.equal(result.status, 200);
  assert.equal((await call('/api/mascotas', { token })).status, 401);
  assert.equal((await call('/api/mascotas', { token: second })).status, 401);
  token = result.body.accessToken;
  assert.equal((await call('/api/mascotas', { token })).status, 200);
  assert.equal((await login(client.email)).status, 401);
  assert.equal((await login(client.email, 'Nueva-segura-456')).status, 200);
  assert.equal(result.body.passwordHash, undefined);
});

test('logout invalida todos los tokens y una cuenta eliminada no puede usar su JWT', async () => {
  const second = (await login(client.email, 'Nueva-segura-456')).body.accessToken;
  assert.equal((await call('/api/sessions', { method: 'DELETE', token })).status, 204);
  assert.equal((await call('/api/mascotas', { token: second })).status, 401);
  token = (await login(client.email, 'Nueva-segura-456')).body.accessToken;
  assert.equal((await call('/api/mascotas', { token })).status, 200);
  const otherToken = (await login(other.email)).body.accessToken;
  await prisma.usuario.delete({ where: { id: other.id } });
  assert.equal((await call('/api/mascotas', { token: otherToken })).status, 401);
});

test('alta de admin y recuperación generan claves aleatorias y exigen cambiarlas', async () => {
  const created = await call('/api/admin/users', { method: 'POST', token: adminToken, body: { nombre: 'Nuevo Admin', email: 'new-admin@test.invalid', telefono: '123' } });
  assert.equal(created.status, 201);
  assert.ok(created.body.temporaryPassword.length >= 20);
  const newLogin = await login(created.body.email, created.body.temporaryPassword);
  assert.equal(newLogin.body.mustChangePassword, true);
  assert.equal((await call('/api/admin/users', { token: newLogin.body.accessToken })).status, 403);
  const changed = await call(`/api/users/${created.body.id}/password`, { method: 'PATCH', token: newLogin.body.accessToken, body: { currentPassword: created.body.temporaryPassword, newPassword: password } });
  assert.equal(changed.status, 200);
  assert.equal((await call('/api/admin/users', { token: changed.body.accessToken })).status, 200);
  await call('/api/password-reset/request', { method: 'POST', body: { email: client.email } });
  const notice = await prisma.notification.findFirst({ where: { userId: admin.id, solicitanteEmail: client.email, tipo: 'recuperacion' } });
  const reset = await call('/api/admin/password-reset', { method: 'POST', token: adminToken, body: { solicitudId: notice.id } });
  assert.equal(reset.status, 200);
  assert.equal((await call('/api/mascotas', { token })).status, 401);
  assert.equal((await login(client.email, 'Nueva-segura-456')).status, 401);
  const logged = await login(client.email, reset.body.password);
  assert.equal(logged.body.mustChangePassword, true);
  assert.equal((await call('/api/turnos', { token: logged.body.accessToken })).body.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await call('/api/admin/password-reset', { method: 'POST', token: adminToken, body: { solicitudId: notice.id } })).status, 409);
  const record = await prisma.usuario.findUnique({ where: { id: client.id } });
  assert.equal(await verifyPassword(record.passwordHash, reset.body.password), true);
  assert.equal((await call('/api/sessions', { method: 'DELETE', token: logged.body.accessToken })).status, 204);
});


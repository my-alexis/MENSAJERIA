const { default: makeWASocket, useMultiFileAuthState } = require('baileys');
const pino = require('pino');

async function test() {
    const { state, saveCreds } = await useMultiFileAuthState('./test-session');
const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    version: [2, 3000, 1015901307], // ← forzar versión manualmente
});
    
    sock.ev.on('connection.update', (update) => {
        console.log('UPDATE:', JSON.stringify(update, null, 2));
    });
    
    sock.ev.on('creds.update', saveCreds);
}



test();
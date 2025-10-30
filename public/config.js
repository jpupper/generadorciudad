// Config mínimo adaptado al generador de ciudades 3D
const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
// Detecta si la app corre bajo el prefijo /generadorciudades (VPS detrás de Nginx)
const hasPrefix = window.location.pathname.startsWith('/generadorciudades');
const prefix = hasPrefix ? '/generadorciudades' : '';

const config = {
  isLocal,
  socketPath: `${prefix}/socket.io`,
  gridSize: 1,
  world: {
    groundSize: 200
  },
  default: {
    shape: 'cube',
    size: 1,
    color: '#7aa1ff'
  }
};

window.appConfig = config;
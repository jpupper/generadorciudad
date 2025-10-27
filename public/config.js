// Config mínimo adaptado al generador de ciudades 3D
const config = {
  isLocal: ['localhost', '127.0.0.1'].includes(window.location.hostname),
  socketPath: '/generadorciudades/socket.io',
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
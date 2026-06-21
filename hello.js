// Hello World in Node.js

console.log('Hello, World!');

// Function version
function sayHello(name = 'World') {
  return `Hello, ${name}!`;
}

// Export for use in other modules
module.exports = { sayHello };

// Example usage
if (require.main === module) {
  console.log(sayHello());
  console.log(sayHello('Antigravity IDE'));
}

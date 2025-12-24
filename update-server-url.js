/**
 * Script to update server URL in HTML files
 * Usage: node update-server-url.js wss://your-project.onrender.com
 */

const fs = require('fs');
const path = require('path');

// Get new URL from command line argument
const newServerUrl = process.argv[2];

if (!newServerUrl) {
    console.error('❌ Error: Please provide server URL as argument');
    console.log('Usage: node update-server-url.js wss://your-project.onrender.com');
    process.exit(1);
}

// Validate URL format
if (!newServerUrl.startsWith('ws://') && !newServerUrl.startsWith('wss://')) {
    console.error('❌ Error: URL must start with ws:// or wss://');
    process.exit(1);
}

// Files to update
const files = ['display.html', 'controller.html'];

// Pattern to find and replace
const pattern = /const defaultServer = isLocalhost \? 'ws:\/\/localhost:8080' : '([^']+)';/;

files.forEach(filename => {
    const filePath = path.join(__dirname, filename);

    try {
        // Read file
        let content = fs.readFileSync(filePath, 'utf8');

        // Replace URL
        const newContent = content.replace(
            pattern,
            `const defaultServer = isLocalhost ? 'ws://localhost:8080' : '${newServerUrl}';`
        );

        // Write back
        fs.writeFileSync(filePath, newContent, 'utf8');

        console.log(`✅ Updated ${filename}`);
    } catch (error) {
        console.error(`❌ Error updating ${filename}:`, error.message);
    }
});

console.log(`\n🎉 Server URL updated to: ${newServerUrl}`);
console.log('\nNext steps:');
console.log('1. git add .');
console.log('2. git commit -m "Update server URL"');
console.log('3. git push');

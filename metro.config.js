const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Add support for react-native-webrtc
config.resolver.sourceExts = [...config.resolver.sourceExts, 'cjs'];

module.exports = config;

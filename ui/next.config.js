const path = require('path');

module.exports = {
  typescript: {
    // !! WARN !!
    // Dangerously allow production builds to successfully complete even if
    // your project has type errors.
    // !! WARN !!
    ignoreBuildErrors: true,
  },
  webpack: (config, { defaultLoaders }) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@/target': path.resolve(__dirname, '../target'),
    };
    
    // Add rule to handle TypeScript files in the target directory
    config.module.rules.push({
      test: /\.ts$/,
      include: [path.resolve(__dirname, '../target')],
      use: defaultLoaders.babel,
    });

    return config;
  },
};

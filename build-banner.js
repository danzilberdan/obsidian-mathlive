const fs = require('fs');

let logoSvg = fs.readFileSync('frontend/src/lib/images/logo.svg', 'utf8');
logoSvg = logoSvg.replace(/<\?xml[\s\S]*?\?>\s*/, '');
logoSvg = logoSvg.replace(/<!DOCTYPE[\s\S]*?>\s*/, '');
logoSvg = logoSvg.replace(/<svg\s+([^>]+)>/, (match, attrs) => {
  let cleanAttrs = attrs.replace(/\b(width|height|x|y)="[^"]*"/g, '');
  return `<svg x="12" y="0" width="180" height="180" ${cleanAttrs}>`;
});

let mathSvg = fs.readFileSync('/tmp/mathjax-cli/math.svg', 'utf8');
mathSvg = mathSvg.replace(/<\?xml[\s\S]*?\?>\s*/, '');
mathSvg = mathSvg.replace(/<svg\s+([^>]+)>/, (match, attrs) => {
  let cleanAttrs = attrs.replace(/\b(width|height|x|y|style)="[^"]*"/g, '');
  return `<svg x="96" y="25" width="300" height="120" style="color: white; overflow: visible;" ${cleanAttrs}>`;
});

const banner = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 600" width="100%" height="100%">
  <defs>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&amp;family=Ubuntu+Mono:wght@400&amp;display=swap');
      
      .title-brand { font-family: 'Montserrat', sans-serif; font-weight: 700; font-size: 72px; fill: #ffffff; letter-spacing: -1.5px; }
      .title-accent { fill: #10b981; }
      .subtitle { font-family: 'Montserrat', sans-serif; font-weight: 500; font-size: 20px; fill: #9ca3af; letter-spacing: 4px; text-transform: uppercase; }
      
      .window-title { font-family: 'Ubuntu Mono', monospace; font-weight: 400; font-size: 14px; fill: #6b7280; letter-spacing: 2px; }
      .box-label { font-family: 'Ubuntu Mono', monospace; font-weight: 400; font-size: 13px; fill: #6b7280; letter-spacing: 2px; }
      .code-text { font-family: 'Ubuntu Mono', monospace; font-weight: 400; font-size: 18px; fill: #d1d5db; }
    </style>
    
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#374151" stroke-width="1" stroke-opacity="0.15"/>
    </pattern>
    
    <radialGradient id="glowLeft" cx="20%" cy="50%" r="60%">
      <stop offset="0%" stop-color="#10b981" stop-opacity="0.08" />
      <stop offset="100%" stop-color="#0e1013" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="glowRight" cx="80%" cy="50%" r="60%">
      <stop offset="0%" stop-color="#34d399" stop-opacity="0.05" />
      <stop offset="100%" stop-color="#0e1013" stop-opacity="0" />
    </radialGradient>
  </defs>

  <rect width="100%" height="100%" fill="#0e1013"/>
  <rect width="100%" height="100%" fill="url(#grid)"/>
  
  <rect width="100%" height="100%" fill="url(#glowLeft)"/>
  <rect width="100%" height="100%" fill="url(#glowRight)"/>

  <!-- Left Section (Text & Branding) -->
  <g transform="translate(60, 60)">
    <!-- Logo and text aligned to the bottom of the window (which has height 480). -->
    <g transform="translate(0, 160)">
      ${logoSvg}
    </g>
    
    <text x="12" y="390" class="subtitle">Obsidian Plugin</text>
    
    <text x="10" y="470" class="title-brand">Math<tspan class="title-accent">Live</tspan></text>
  </g>

  <!-- Right Section (The App Window) -->
  <g transform="translate(540, 60)">
    <!-- Window Base (Simplified, no brutalist shadow) -->
    <rect x="0" y="0" width="600" height="480" rx="8" fill="#0e1013" stroke="#374151" stroke-width="1" />
    
    <!-- Window Header -->
    <path d="M 0 8 C 0 3.58 3.58 0 8 0 L 592 0 C 596.42 0 600 3.58 600 8 L 600 48 L 0 48 Z" fill="#1a1d23" />
    <line x1="0" y1="48" x2="600" y2="48" stroke="#374151" stroke-width="1"/>
    
    <!-- Window Controls (Subdued) -->
    <circle cx="24" cy="24" r="6" fill="#4b5563"/>
    <circle cx="44" cy="24" r="6" fill="#4b5563"/>
    <circle cx="64" cy="24" r="6" fill="#4b5563"/>
    
    <text x="96" y="29" class="window-title">OBSIDIAN</text>
    
    <!-- Editor Container -->
    <g transform="translate(30, 80)">
      <!-- Box fill -->
      <rect x="0" y="0" width="540" height="250" rx="6" fill="#1a1d23" stroke="#374151" stroke-width="1" />
      
      <text x="24" y="32" class="box-label">VISUAL FORMULA EDITOR</text>
      
      <!-- Dropzone (Simplified) -->
      <rect x="24" y="56" width="492" height="170" rx="4" fill="#16181d" stroke="#1f2937" stroke-width="1" />
      
      <!-- Math SVG inside dropzone -->
      <g transform="translate(24, 56)">
        ${mathSvg}
      </g>
    </g>

    <!-- LaTeX Output Container -->
    <g transform="translate(30, 360)">
      <!-- Box fill -->
      <rect x="0" y="0" width="540" height="90" rx="6" fill="#1a1d23" stroke="#374151" stroke-width="1" />
      
      <text x="24" y="30" class="box-label">GENERATED LATEX</text>
      
      <!-- Input inset style (Simplified) -->
      <rect x="24" y="42" width="492" height="36" rx="4" fill="#0e1013" stroke="#1f2937" stroke-width="1" />
      
      <text x="40" y="66" class="code-text">
        <tspan fill="#9ca3af">$$ </tspan>
        <tspan fill="#d1d5db">\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx</tspan>
        <tspan fill="#9ca3af"> $$</tspan>
      </text>
    </g>
  </g>
</svg>
`;

fs.writeFileSync('obsidian-mathlive/banner.svg', banner);

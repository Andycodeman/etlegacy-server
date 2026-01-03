import React from 'react';

// ET:Legacy official color table (from q_math.c g_color_table)
// 32 colors indexed by: (ASCII_value - '0') & 31
// This is the Quake 3 color system used by ET:Legacy
const g_color_table: [number, number, number][] = [
  [0.0,  0.0,  0.0 ],   // 0 - black
  [1.0,  0.0,  0.0 ],   // 1 - red
  [0.0,  1.0,  0.0 ],   // 2 - green
  [1.0,  1.0,  0.0 ],   // 3 - yellow
  [0.0,  0.0,  1.0 ],   // 4 - blue
  [0.0,  1.0,  1.0 ],   // 5 - cyan
  [1.0,  0.0,  1.0 ],   // 6 - purple/magenta
  [1.0,  1.0,  1.0 ],   // 7 - white
  [1.0,  0.5,  0.0 ],   // 8 - orange
  [0.5,  0.5,  0.5 ],   // 9 - md.grey
  [0.75, 0.75, 0.75],   // : (10) - lt.grey
  [0.75, 0.75, 0.75],   // ; (11) - lt.grey
  [0.0,  0.5,  0.0 ],   // < (12) - md.green
  [0.5,  0.5,  0.0 ],   // = (13) - md.yellow/olive
  [0.0,  0.0,  0.5 ],   // > (14) - md.blue/navy
  [0.5,  0.0,  0.0 ],   // ? (15) - md.red
  [0.5,  0.25, 0.0 ],   // @ (16) - md.orange/brown
  [1.0,  0.6,  0.1 ],   // A (17) - lt.orange
  [0.0,  0.5,  0.5 ],   // B (18) - md.cyan/teal
  [0.5,  0.0,  0.5 ],   // C (19) - md.purple
  [0.0,  0.5,  1.0 ],   // D (20) - lt.blue
  [0.5,  0.0,  1.0 ],   // E (21) - blue-violet
  [0.2,  0.6,  0.8 ],   // F (22) - steel blue
  [0.8,  1.0,  0.8 ],   // G (23) - lt.green/mint
  [0.0,  0.4,  0.2 ],   // H (24) - dk.green
  [1.0,  0.0,  0.2 ],   // I (25) - deep pink/red
  [0.7,  0.1,  0.1 ],   // J (26) - crimson/claret
  [0.6,  0.2,  0.0 ],   // K (27) - dk.orange/brown
  [0.8,  0.6,  0.2 ],   // L (28) - lt.brown/tan
  [0.6,  0.6,  0.2 ],   // M (29) - olive/khaki
  [1.0,  1.0,  0.75],   // N (30) - lt.yellow/beige
  [1.0,  1.0,  0.5 ],   // O (31) - yellow/cream
];

/**
 * Convert a character after ^ to its color index
 * Uses the Quake 3 formula: (charCode - '0') & 31
 */
function getColorIndex(char: string): number {
  return (char.charCodeAt(0) - 48) & 31; // 48 = '0'
}

/**
 * Convert RGB float values (0-1) to CSS hex color
 */
function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Get the CSS color for an ET color code character
 */
function getETColor(char: string): string {
  const index = getColorIndex(char);
  const [r, g, b] = g_color_table[index];
  return rgbToHex(r, g, b);
}

/**
 * Strip ET color codes from text
 * Matches ^X where X is any character (ET uses ANY char after ^)
 * Also handles ^^ which represents a literal ^
 */
export function stripColors(text: string): string {
  // Replace ^^ with a placeholder, strip ^X codes, then restore ^^
  return text
    .replace(/\^\^/g, '\x00')  // Placeholder for literal ^
    .replace(/\^./g, '')       // Remove all ^X color codes
    .replace(/\x00/g, '^');    // Restore literal ^
}

/**
 * Render ET color codes as React elements with colored spans
 * Supports ALL ET color codes (^0-^9, ^a-^z, ^A-^Z, and symbols like ^?, ^<, ^>, etc.)
 * Uses the official Quake 3 formula: colorIndex = (charCode - '0') & 31
 */
export function renderETColors(text: string): React.ReactNode {
  if (!text) return null;

  const parts: React.ReactNode[] = [];
  let currentColor = '#ffffff'; // Default to white
  let keyIndex = 0;
  let i = 0;
  let segmentStart = 0;

  while (i < text.length) {
    if (text[i] === '^' && i + 1 < text.length) {
      const nextChar = text[i + 1];

      // Handle ^^ (escaped caret - displays as single ^)
      if (nextChar === '^') {
        // Add text before this ^^
        if (i > segmentStart) {
          parts.push(
            <span key={keyIndex++} style={{ color: currentColor }}>
              {text.slice(segmentStart, i)}
            </span>
          );
        }
        // Add a single ^ with current color
        parts.push(
          <span key={keyIndex++} style={{ color: currentColor }}>
            ^
          </span>
        );
        i += 2;
        segmentStart = i;
        continue;
      }

      // Color code: ^X where X is any character
      // Add text before the color code
      if (i > segmentStart) {
        parts.push(
          <span key={keyIndex++} style={{ color: currentColor }}>
            {text.slice(segmentStart, i)}
          </span>
        );
      }

      // Update current color using the official ET formula
      currentColor = getETColor(nextChar);
      i += 2;
      segmentStart = i;
    } else {
      i++;
    }
  }

  // Add any remaining text
  if (segmentStart < text.length) {
    parts.push(
      <span key={keyIndex++} style={{ color: currentColor }}>
        {text.slice(segmentStart)}
      </span>
    );
  }

  return parts.length > 0 ? <>{parts}</> : text;
}

import React from 'react';

// ET color code to CSS color mapping
const etColors: Record<string, string> = {
  '0': '#000000', // Black
  '1': '#ff0000', // Red
  '2': '#00ff00', // Green
  '3': '#ffff00', // Yellow
  '4': '#0000ff', // Blue
  '5': '#00ffff', // Cyan
  '6': '#ff00ff', // Magenta
  '7': '#ffffff', // White
  '8': '#ff8000', // Orange
  '9': '#808080', // Gray
  'a': '#ff0000', 'A': '#ff0000',
  'b': '#00ff00', 'B': '#00ff00',
  'c': '#0000ff', 'C': '#0000ff',
  'd': '#00ffff', 'D': '#00ffff',
  'e': '#ffff00', 'E': '#ffff00',
  'f': '#ff00ff', 'F': '#ff00ff',
};

/**
 * Strip ET color codes from text
 */
export function stripColors(text: string): string {
  return text.replace(/\^[0-9a-zA-Z]/g, '');
}

/**
 * Render ET color codes as React elements with colored spans
 */
export function renderETColors(text: string): React.ReactNode {
  if (!text) return null;

  const parts: React.ReactNode[] = [];
  const regex = /\^([0-9a-fA-F])/g;
  let lastIndex = 0;
  let currentColor = '#ffffff';
  let match;
  let keyIndex = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const segment = text.slice(lastIndex, match.index);
      parts.push(
        <span key={keyIndex++} style={{ color: currentColor }}>
          {segment}
        </span>
      );
    }
    currentColor = etColors[match[1]] || '#ffffff';
    lastIndex = match.index + 2;
  }

  if (lastIndex < text.length) {
    parts.push(
      <span key={keyIndex++} style={{ color: currentColor }}>
        {text.slice(lastIndex)}
      </span>
    );
  }

  return parts.length > 0 ? <>{parts}</> : text;
}

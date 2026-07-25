import { useState } from "react";
import { Box, Text, useInput } from "ink";

export type SelectOption<T extends string> = {
  name: string;
  description?: string;
  value: T;
};

type Props<T extends string> = {
  options: readonly SelectOption<T>[];
  onSelect: (option: SelectOption<T>) => void;
  initialIndex?: number;
  isFocused?: boolean;
};

export function SelectMenu<T extends string>({
  options,
  onSelect,
  initialIndex = 0,
  isFocused = true,
}: Props<T>) {
  const lastIndex = Math.max(0, options.length - 1);
  const [selectedIndex, setSelectedIndex] = useState(
    Math.min(Math.max(0, initialIndex), lastIndex),
  );

  useInput(
    (input, key) => {
      const pageSize = key.shift ? 5 : 1;

      if (key.upArrow || input === "k") {
        setSelectedIndex((index) => Math.max(0, index - pageSize));
        return;
      }

      if (key.downArrow || input === "j") {
        setSelectedIndex((index) => Math.min(lastIndex, index + pageSize));
        return;
      }

      if (key.return) {
        const option = options[selectedIndex];
        if (option) onSelect(option);
      }
    },
    { isActive: isFocused },
  );

  return (
    <Box flexDirection="column">
      {options.map((option, index) => {
        const isSelected = index === selectedIndex;
        return (
          <Box key={option.value} flexDirection="column">
            <Text color={isSelected ? "cyan" : undefined}>
              {isSelected ? "❯ " : "  "}
              {option.name}
            </Text>
            {option.description && (
              <Text dimColor>
                {"    "}
                {option.description}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

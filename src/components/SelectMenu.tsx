import { useRef, useState } from "react";
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
  const initialSelectedIndex = Math.min(Math.max(0, initialIndex), lastIndex);
  const [selectedIndex, setSelectedIndex] = useState(initialSelectedIndex);
  const selectedIndexRef = useRef(initialSelectedIndex);

  useInput(
    (input, key) => {
      const pageSize = key.shift ? 5 : 1;

      if (key.upArrow || input === "k") {
        const nextIndex = Math.max(
          0,
          selectedIndexRef.current - pageSize,
        );
        selectedIndexRef.current = nextIndex;
        setSelectedIndex(nextIndex);
        return;
      }

      if (key.downArrow || input === "j") {
        const nextIndex = Math.min(
          lastIndex,
          selectedIndexRef.current + pageSize,
        );
        selectedIndexRef.current = nextIndex;
        setSelectedIndex(nextIndex);
        return;
      }

      if (key.return) {
        const option = options[selectedIndexRef.current];
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

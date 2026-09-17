import { useEffect, useState } from "react";
import { AppShell, MantineProvider, createTheme } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import App from "./App.tsx";
import {
  MIN_NAVIGATION_WIDTH,
  clampNavigationWidth,
  defaultNavigationWidth,
  maxNavigationWidth,
  persistNavigationWidth,
  readStoredNavigationWidth,
} from "./components/Navigation/navigationWidth";

const theme = createTheme({
  colors: {
    dark: [
      "#C1C2C5",
      "#A6A7AB",
      "#909296",
      "#5c5f66",
      "#373A40",
      "#2C2E33",
      "#25262b",
      "#1A1B1E",
      "#141517",
      "#101113",
    ],
  },
});

export default function Root() {
  // The tree's width is clamped against the live viewport: a stored width
  // from a wide monitor is narrowed on a laptop, and shrinking the window
  // never lets the tree squeeze the content pane below its minimum.
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [navigationWidth, setNavigationWidth] = useState(() =>
    readStoredNavigationWidth(window.innerWidth),
  );

  useEffect(() => {
    const handleResize = () => {
      const nextViewportWidth = window.innerWidth;
      setViewportWidth(nextViewportWidth);
      setNavigationWidth((current) =>
        clampNavigationWidth(current, nextViewportWidth),
      );
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    persistNavigationWidth(navigationWidth);
  }, [navigationWidth]);

  const changeNavigationWidth = (width: number) => {
    setNavigationWidth(clampNavigationWidth(width, viewportWidth));
  };

  return (
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <Notifications position="top-right" />
      <AppShell
        navbar={{
          width: navigationWidth,
          breakpoint: 0,
        }}
        header={{
          height: { base: 180, xs: 120, md: 60 },
        }}
        footer={{
          height: { base: 120, xs: 80, md: 40 },
        }}
        transitionDuration={0}
      >
        <App
          navigationWidth={navigationWidth}
          navigationMinWidth={MIN_NAVIGATION_WIDTH}
          navigationMaxWidth={maxNavigationWidth(viewportWidth)}
          onNavigationWidthChange={changeNavigationWidth}
          onNavigationWidthReset={() => {
            changeNavigationWidth(defaultNavigationWidth(viewportWidth));
          }}
        />
      </AppShell>
    </MantineProvider>
  );
}

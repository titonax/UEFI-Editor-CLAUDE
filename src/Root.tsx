import { useEffect, useState } from "react";
import { AppShell, MantineProvider, createTheme } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import App from "./App.tsx";
import { loadNavbarWidth, saveNavbarWidth } from "./navbarWidth";

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
  const [navbarWidth, setNavbarWidth] = useState(loadNavbarWidth);

  useEffect(() => {
    saveNavbarWidth(navbarWidth);
  }, [navbarWidth]);

  return (
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <Notifications position="top-right" />
      <AppShell
        navbar={{
          width: navbarWidth,
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
        <App navbarWidth={navbarWidth} setNavbarWidth={setNavbarWidth} />
      </AppShell>
    </MantineProvider>
  );
}

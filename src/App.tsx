import React from "react";
import s from "./App.module.css";
import { useImmer, type Updater } from "use-immer";
import { AppShell, Button, Group, Stack } from "@mantine/core";
import type { Data } from "./components/scripts/types";
import FileUploads, {
  type Files,
  type PopulatedFiles,
} from "./components/FileUploads/FileUploads";
import FormUi from "./components/FormUi/FormUi";
import Navigation from "./components/Navigation/Navigation";
import NavbarResizeHandle from "./components/Navigation/NavbarResizeHandle";
import Header from "./components/Header/Header";
import Footer from "./components/Footer/Footer";
import { IconBrandGithub } from "@tabler/icons-react";
import BiosImageUpload from "./components/BiosImageUpload/BiosImageUpload";
import { parseData } from "./components/scripts/ifrParser";
import { TOP_LEVEL_MENU_VIEW } from "./formNavigation";
import { buildMenuTree } from "./components/Navigation/menuTree";
import { applyLoadedData } from "./loadedData";

interface AppProps {
  navbarWidth: number;
  setNavbarWidth: (width: number) => void;
}

export default function App({ navbarWidth, setNavbarWidth }: AppProps) {
  const [files, setFiles] = useImmer<Files>({
    setupSctContainer: { isWrongFile: false },
    setupTxtContainer: { isWrongFile: false },
    amitseSctContainer: { isWrongFile: false },
    setupdataBinContainer: { isWrongFile: false },
  });

  const [data, setData] = useImmer<Data | null>(null);

  // Typed as Updater<Data> so children (rendered only once data is loaded)
  // don't need a `Data | null` type themselves - no `{} as Data` placeholder
  // and no casts. applyLoadedData still accepts the very first, initial
  // assignment (a plain Data value while draft is still null).
  const setLoadedData: Updater<Data> = (recipe) => {
    setData((draft) => applyLoadedData(recipe, draft));
  };

  const [currentFormIndex, setCurrentFormIndex] = React.useState(
    TOP_LEVEL_MENU_VIEW,
  );

  // Computed once here instead of independently inside Navigation, Header,
  // and FormUi - it's a non-trivial recursive walk of the whole form graph
  // (cycle detection, orphan detection, profile inference), and all three
  // need the exact same result on every `data` change.
  const tree = React.useMemo(() => (data ? buildMenuTree(data) : null), [
    data,
  ]);

  if (!data || !tree) {
    return (
      <Stack className={s.padding} gap="xl">
        <BiosImageUpload
          onExtracted={async (extractedFiles) => {
            // Parse first, then set `files` and `data` together. Setting
            // `files` before `data` is ready would re-render FileUploads
            // with all four slots already populated - its own effect would
            // then kick off a second, redundant parseData() in parallel
            // with this one, racing to overwrite whichever data lands last.
            const parsed = await parseData(extractedFiles);
            parsed.firmwareFamily = "aptio-iv";
            setFiles(extractedFiles);
            setLoadedData(parsed);
          }}
        />
        <FileUploads files={files} setFiles={setFiles} setData={setLoadedData} />
        <Group justify="center">
          <Button
            variant="default"
            size="lg"
            component="a"
            href="https://github.com/BoringBoredom/UEFI-Editor#usage-guide"
            target="_blank"
            leftSection={<IconBrandGithub />}
          >
            Usage guide
          </Button>
          <Button
            variant="default"
            size="lg"
            component="a"
            href="https://github.com/BoringBoredom/UEFI-Editor/issues"
            target="_blank"
            leftSection={<IconBrandGithub />}
          >
            Report a bug
          </Button>
        </Group>
      </Stack>
    );
  }

  return (
    <>
      <AppShell.Navbar style={{ position: "relative" }}>
        <Navigation
          data={data}
          tree={tree}
          currentFormIndex={currentFormIndex}
          setCurrentFormIndex={setCurrentFormIndex}
        />
        <NavbarResizeHandle width={navbarWidth} setWidth={setNavbarWidth} />
      </AppShell.Navbar>
      <AppShell.Header>
        <Header
          tree={tree}
          currentFormIndex={currentFormIndex}
          setCurrentFormIndex={setCurrentFormIndex}
        />
      </AppShell.Header>
      <AppShell.Footer>
        <Footer
          currentFormIndex={currentFormIndex}
          files={files as PopulatedFiles}
          data={data}
          setData={setLoadedData}
        />
      </AppShell.Footer>
      <AppShell.Main>
        <FormUi
          data={data}
          tree={tree}
          setData={setLoadedData}
          currentFormIndex={currentFormIndex}
          setCurrentFormIndex={setCurrentFormIndex}
        />
      </AppShell.Main>
    </>
  );
}

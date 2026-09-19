import React from "react";
import s from "./App.module.css";
import { useImmer, type Updater } from "use-immer";
import { AppShell, Button, Divider, Group, Stack } from "@mantine/core";
import type { Data } from "./components/scripts/types";
import type { Files, PopulatedFiles } from "./components/FileUploads/fileModel";
import FormUi from "./components/FormUi/FormUi";
import Navigation from "./components/Navigation/Navigation";
import NavigationResizer from "./components/Navigation/NavigationResizer";
import Header from "./components/Header/Header";
import Footer from "./components/Footer/Footer";
import { IconBrandGithub } from "@tabler/icons-react";
import BiosImageUpload from "./components/BiosImageUpload/BiosImageUpload";
import CorpusRunner from "./components/CorpusRunner/CorpusRunner";
import { parseData } from "./components/scripts/ifrParser";
import { TOP_LEVEL_MENU_VIEW } from "./formNavigation";
import { buildMenuTree } from "./components/Navigation/menuTree";
import { applyLoadedData } from "./loadedData";

interface AppProps {
  navigationWidth: number;
  navigationMinWidth: number;
  navigationMaxWidth: number;
  onNavigationWidthChange: (width: number) => void;
  onNavigationWidthReset: () => void;
}

export default function App({
  navigationWidth,
  navigationMinWidth,
  navigationMaxWidth,
  onNavigationWidthChange,
  onNavigationWidthReset,
}: AppProps) {
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

  // `data` only ever exists once all four files were loaded and parsed.
  const loadedFiles = files as PopulatedFiles;

  if (!data || !tree) {
    return (
      <Stack className={s.padding} gap="xl">
        <BiosImageUpload
          onExtracted={async (extractedFiles) => {
            const parsed = await parseData(extractedFiles);
            // The preflight is the only place the generation is assessed
            // from real evidence; the four-file parse has none.
            const generation =
              extractedFiles.firmwareSource?.generation ?? "unresolved";
            parsed.firmwareFamily =
              generation === "unresolved" ? "ami-aptio" : generation;
            setFiles(extractedFiles);
            setLoadedData(parsed);
          }}
        />
        <Divider label="Or measure a local firmware corpus" />
        <CorpusRunner />
        <Group justify="center">
          <Button
            variant="default"
            size="lg"
            component="a"
            href="https://github.com/titonax/UEFI-Editor-CLAUDE#using-it"
            target="_blank"
            leftSection={<IconBrandGithub />}
          >
            Usage guide
          </Button>
          <Button
            variant="default"
            size="lg"
            component="a"
            href="https://github.com/titonax/UEFI-Editor-CLAUDE/issues"
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
      <AppShell.Navbar>
        <Navigation
          data={data}
          setData={setLoadedData}
          tree={tree}
          currentFormIndex={currentFormIndex}
          setCurrentFormIndex={setCurrentFormIndex}
          originalSetupSct={loadedFiles.setupSctContainer.textContent}
        />
        {/* The navbar is AppShell's own fixed-position element, so the
            absolutely positioned handle spans exactly its right edge. */}
        <NavigationResizer
          width={navigationWidth}
          minWidth={navigationMinWidth}
          maxWidth={navigationMaxWidth}
          onChange={onNavigationWidthChange}
          onReset={onNavigationWidthReset}
        />
      </AppShell.Navbar>
      <AppShell.Header>
        <Header
          tree={tree}
          fileName={
            loadedFiles.firmwareSource?.fileName ??
            loadedFiles.setupSctContainer.file.name
          }
          currentFormIndex={currentFormIndex}
          setCurrentFormIndex={setCurrentFormIndex}
        />
      </AppShell.Header>
      <AppShell.Footer>
        <Footer
          currentFormIndex={currentFormIndex}
          files={loadedFiles}
          data={data}
          setData={setLoadedData}
        />
      </AppShell.Footer>
      <AppShell.Main>
        <FormUi
          data={data}
          tree={tree}
          setData={setLoadedData}
          originalSetupSct={loadedFiles.setupSctContainer.textContent}
          currentFormIndex={currentFormIndex}
          setCurrentFormIndex={setCurrentFormIndex}
        />
      </AppShell.Main>
    </>
  );
}

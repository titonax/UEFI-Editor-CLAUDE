import React from "react";
import s from "./App.module.css";
import { useImmer } from "use-immer";
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
import { useDataChangeQueue } from "./components/ChangeQueue/useDataChangeQueue";

// use-immer's Updater<Data> needs a real Data to produce a draft from, so
// the change queue (see useDataChangeQueue.ts) is created with this
// placeholder up front rather than waiting for real data to exist; `loaded`
// below is what actually gates rendering the editor.
const emptyData: Data = {
  firmwareFamily: "ami-aptio",
  menu: [],
  forms: [],
  varStores: [],
  suppressions: [],
  version: "",
  hashes: {
    setupTxt: "",
    setupSct: "",
    amitseSct: "",
    setupdataBin: "",
    offsetChecksum: "",
  },
};

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

  // Every edit handler below (Navigation, FormUi and everything under it,
  // Footer's own quick actions) still calls `setData(draft => {...})`
  // exactly as before - `setData` is now the queue's own enqueueData, a
  // drop-in Updater<Data>, so each edit stages a described, toggleable
  // Change queue entry instead of committing immediately. See
  // ChangeQueue/useDataChangeQueue.ts for the mechanism and
  // docs/change-queue.md for why this is safe to bolt on without touching
  // any existing edit logic.
  const dataQueue = useDataChangeQueue(emptyData);
  const data = dataQueue.previewData;
  const setData = dataQueue.enqueueData;
  const [loaded, setLoaded] = React.useState(false);

  const [currentFormIndex, setCurrentFormIndex] = React.useState(
    TOP_LEVEL_MENU_VIEW,
  );

  // Computed once here instead of independently inside Navigation, Header,
  // and FormUi - it's a non-trivial recursive walk of the whole form graph
  // (cycle detection, orphan detection, profile inference), and all three
  // need the exact same result on every `data` change.
  const tree = React.useMemo(() => (loaded ? buildMenuTree(data) : null), [
    data,
    loaded,
  ]);

  // `data` only ever exists once all four files were loaded and parsed.
  const loadedFiles = files as PopulatedFiles;

  if (!loaded || !tree) {
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
            // The very first load starts a fresh queue on this firmware's
            // own data, rather than being staged as a reviewable "edit" of
            // the emptyData placeholder.
            dataQueue.replaceBase(parsed);
            setLoaded(true);
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
          setData={setData}
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
          appliedData={dataQueue.appliedData}
          changeQueue={dataQueue}
          setData={setData}
        />
      </AppShell.Footer>
      <AppShell.Main>
        <FormUi
          data={data}
          tree={tree}
          setData={setData}
          originalSetupSct={loadedFiles.setupSctContainer.textContent}
          currentFormIndex={currentFormIndex}
          setCurrentFormIndex={setCurrentFormIndex}
        />
      </AppShell.Main>
    </>
  );
}

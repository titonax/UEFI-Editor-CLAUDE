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
import Header from "./components/Header/Header";
import Footer from "./components/Footer/Footer";
import { IconBrandGithub } from "@tabler/icons-react";
import BiosImageUpload from "./components/BiosImageUpload/BiosImageUpload";
import { parseData } from "./components/scripts/ifrParser";

export default function App() {
  const [files, setFiles] = useImmer<Files>({
    setupSctContainer: { isWrongFile: false },
    setupTxtContainer: { isWrongFile: false },
    amitseSctContainer: { isWrongFile: false },
    setupdataBinContainer: { isWrongFile: false },
  });

  const [data, setData] = useImmer<Data | null>(null);

  // Children only ever see setLoadedData once `data` is confirmed non-null
  // (they're rendered inside the `data ?` branch below), so it's typed as
  // Updater<Data> for them - no `{} as Data` placeholder and no casts here.
  const setLoadedData: Updater<Data> = (recipe) => {
    setData((draft) => {
      if (draft === null) {
        return;
      }
      if (typeof recipe === "function") {
        recipe(draft);
      } else {
        return recipe;
      }
    });
  };

  const [currentFormIndex, setCurrentFormIndex] = React.useState(-1);

  return (
    <>
      {data ? (
        <>
          <AppShell.Navbar>
            <Navigation
              data={data}
              currentFormIndex={currentFormIndex}
              setCurrentFormIndex={setCurrentFormIndex}
            />
          </AppShell.Navbar>
          <AppShell.Header>
            <Header
              data={data}
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
              setData={setLoadedData}
              currentFormIndex={currentFormIndex}
              setCurrentFormIndex={setCurrentFormIndex}
            />
          </AppShell.Main>
        </>
      ) : (
        <Stack className={s.padding} gap="xl">
          <BiosImageUpload
            onExtracted={async (extractedFiles) => {
              setFiles(extractedFiles);
              const parsed = await parseData(extractedFiles);
              parsed.firmwareFamily = "aptio-iv";
              setLoadedData(parsed);
            }}
          />
          <FileUploads
            files={files}
            setFiles={setFiles}
            setData={setLoadedData}
          />
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
      )}
    </>
  );
}

import React, { useId, useState } from 'react';
import { Button, Field, Input, Modal, useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';

import { NodeKind } from '../../../generated/explorer/user_storage_pb';
import { nameTaken, type MenuNode } from '../menuModel';
import { nameProblem, normalizeName } from '../validation';

/** Manage favorites → Rename: a new name for a folder or favorite, unique among its siblings. */
export const RenameDialog: React.FC<{
  node: MenuNode;
  siblings: MenuNode[];
  onRename: (name: string) => void;
  onDismiss: () => void;
}> = ({ node, siblings, onRename, onDismiss }) => {
  const styles = useStyles2(getStyles);
  const id = useId();
  const [name, setName] = useState(node.name);
  const [problem, setProblem] = useState('');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = normalizeName(name);
    const why =
      nameProblem(normalized) ??
      (nameTaken(siblings, normalized, node.ref) ? `“${normalized}” already exists in this folder.` : null);
    if (why) {
      setProblem(why);
      return;
    }
    onRename(normalized);
  };

  return (
    <Modal
      title={node.kind === NodeKind.FOLDER ? 'Rename folder' : 'Rename favorite'}
      isOpen
      onDismiss={onDismiss}
      className={styles.modal}
    >
      <form onSubmit={submit}>
        <Field label="Name" invalid={!!problem} error={problem} htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            value={name}
            onChange={(event) => {
              setName(event.currentTarget.value);
              setProblem('');
            }}
          />
        </Field>
        <Modal.ButtonRow>
          <Button variant="secondary" fill="outline" onClick={onDismiss}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon="pen" disabled={!normalizeName(name)}>
            Rename
          </Button>
        </Modal.ButtonRow>
      </form>
    </Modal>
  );
};

const getStyles = () => ({
  modal: css({
    width: 'min(480px, calc(100vw - 32px))',
  }),
});

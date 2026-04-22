import { Background, ReactFlow, type Edge, type Node } from "@xyflow/react";
import { useMemo } from "react";

import type { KnowledgeNetworkResponse } from "../../types";

type TagNetworkProps = {
  network: KnowledgeNetworkResponse;
  selectedTags: string[];
  expanded: boolean;
  onToggleExpanded(): void;
  onToggleTag(tag: string): void;
  onSelectVideo(videoId: string): void;
};

function truncateLabel(label: string, max = 12) {
  return label.length > max ? `${label.slice(0, max)}…` : label;
}

export function TagNetwork({
  network,
  selectedTags,
  expanded,
  onToggleExpanded,
  onToggleTag,
  onSelectVideo,
}: TagNetworkProps) {
  const { nodes, edges } = useMemo(() => {
    const tagNodes = network.nodes.filter((node) => node.type === "tag");
    const videoNodes = network.nodes.filter((node) => node.type === "video");
    const selected = new Set(selectedTags);
    const tagCount = Math.max(1, tagNodes.length);
    const centerX = selected.size ? 260 : 360;
    const centerY = 220;
    const radiusX = selected.size ? 240 : 300;
    const radiusY = selected.size ? 160 : 190;

    const flowNodes: Node[] = tagNodes.map((node, index) => {
      const angle = selected.size
        ? (-Math.PI / 2) + (Math.PI * index) / Math.max(1, tagCount - 1)
        : (-Math.PI / 2) + (2 * Math.PI * index) / tagCount;
      const position = node.focus
        ? { x: centerX - 72 + index * 16, y: centerY - 24 }
        : {
            x: centerX + Math.cos(angle) * radiusX,
            y: centerY + Math.sin(angle) * radiusY,
          };
      return {
        id: node.id,
        data: { label: `${truncateLabel(node.label)}${node.count ? ` · ${node.count}` : ""}` },
        position,
        className: `knowledge-flow-node is-tag ${selected.has(node.label) ? "is-active" : ""} ${node.focus ? "is-focus" : ""}`,
        type: "default",
      };
    });

    const videoColumns = selected.size ? 2 : 1;
    const videoCardWidth = 210;
    const videoStartX = selected.size ? 620 : 740;
    const videoStartY = 60;
    flowNodes.push(
      ...videoNodes.map((node, index) => ({
        id: node.id,
        data: { label: truncateLabel(node.label, 18) },
        position: {
          x: videoStartX + (index % videoColumns) * (videoCardWidth + 18),
          y: videoStartY + Math.floor(index / videoColumns) * 92,
        },
        className: "knowledge-flow-node is-video",
        type: "default",
      })),
    );

    const flowEdges: Edge[] = network.links.map((link) => ({
      id: `${link.source}-${link.target}`,
      source: link.source,
      target: link.target,
      animated: false,
      className: `knowledge-flow-edge is-${link.kind || "cooccurrence"}`,
      style: {
        strokeWidth: link.kind === "association" ? 1.1 : Math.min(4, 1 + Number(link.weight || 1) * 0.35),
        opacity: link.kind === "association" ? 0.34 : Math.min(0.75, 0.25 + Number(link.weight || 1) * 0.08),
      },
    }));

    return { nodes: flowNodes, edges: flowEdges };
  }, [network, selectedTags]);

  return (
    <div className="knowledge-network-card">
      <div className="knowledge-section-head">
        <div>
          <h3>标签关系概览</h3>
          <p>
            {selectedTags.length
              ? "聚焦已选标签与相关视频。再点一次标签即可取消。"
              : "默认只显示高价值标签与共现关系，避免全量图谱噪音。"}
          </p>
        </div>
        <div className="knowledge-section-actions">
          {selectedTags.length ? (
            <button className="tertiary-button" type="button" onClick={() => selectedTags.forEach((tag) => onToggleTag(tag))}>
              清空聚焦
            </button>
          ) : null}
          {network.hidden_tag_count ? (
            <button className="tertiary-button" type="button" onClick={onToggleExpanded}>
              {expanded ? "收起长尾标签" : `查看更多标签 · ${network.hidden_tag_count}`}
            </button>
          ) : null}
        </div>
      </div>
      <div className="knowledge-network-canvas">
        <ReactFlow
          fitView
          fitViewOptions={{ padding: 0.18, maxZoom: 1.08 }}
          nodes={nodes}
          edges={edges}
          onNodeClick={(_event, node) => {
            if (String(node.id).startsWith("tag_")) {
              onToggleTag(String(node.id).replace(/^tag_/, ""));
              return;
            }
            if (String(node.id).startsWith("video_")) {
              onSelectVideo(String(node.id).replace(/^video_/, ""));
            }
          }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag
          zoomOnScroll={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1} />
        </ReactFlow>
      </div>
    </div>
  );
}

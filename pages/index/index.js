const { translateClause } = require('../../utils/translator');
const { API } = require('../../utils/config');

const SAMPLES = [
  '被保险人于本合同生效之日起90日内，因意外伤害以外的原因导致身故或确诊为本合同约定的重大疾病、中症疾病、轻症疾病的，本公司不承担保险责任，本合同终止，本公司向投保人退还本合同的现金价值。',
  '本保险的免赔额为人民币10000元。被保险人实际支付的合理且必需的医疗费用，在扣除免赔额后，本公司按100%的比例给付医疗保险金。若被保险人以有社保身份参保，但未以社保身份就诊并结算的，本公司按60%的比例给付。',
  '被保险人因遭受意外伤害事故，并自事故发生之日起180日内因该事故身故的，本公司按本合同的意外身故保险金额给付意外身故保险金。',
  '被保险机动车在保险期间内发生保险合同约定的保险事故，造成第三者人身伤亡或财产直接损毁的，由本公司依照道路交通安全法律法规和本合同的约定，在责任限额内予以赔偿。',
];

Page({
  data: {
    inputText: '',
    imagePath: '',
    fileContent: '',
    fileName: '',
    isLoading: false,
    loadingText: '',
    hasResult: false,
    resultType: '',
    // 词典结果
    changes: [],
    stats: { termCount: 0, beforeLevel: '', afterLevel: '' },
    // AI 后台补充
    isDiscovering: false,
    // 询问
    askTerm: '',
    askResult: null,
  },

  // ── 导航 ──
  goCompare() { wx.navigateTo({ url: '/pages/compare/compare' }); },
  goQuote() { wx.navigateTo({ url: '/pages/quote/quote' }); },

  // ── 文本输入 ──
  onInput(e) { this.setData({ inputText: e.detail.value }); },

  loadSample(e) {
    const idx = parseInt(e.currentTarget.dataset.index, 10);
    this.setData({ inputText: SAMPLES[idx] || '', hasResult: false });
  },

  // ── 图片 ──
  onChooseImage() {
    wx.chooseImage({
      count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'],
      success: (res) => { this.setData({ imagePath: res.tempFilePaths[0], hasResult: false }); }
    });
  },

  onAnalyzeImage() {
    this.setData({ isLoading: true, loadingText: '保险专家正在分析图片...', hasResult: false });
    const fs = wx.getFileSystemManager();
    fs.readFile({
      filePath: this.data.imagePath, encoding: 'base64',
      success: (res) => {
        wx.request({
          url: API + '/api/ai/analyze-image', method: 'POST',
          data: { imageBase64: res.data },
          success: (resp) => {
            this.setData({ isLoading: false });
            if (resp.data.error) {
              wx.showToast({ title: resp.data.error, icon: 'none' });
            } else {
              this.setData({ hasResult: true, resultType: 'image', aiResult: resp.data.result, imagePath: '' });
            }
          },
          fail: () => {
            wx.showToast({ title: '连接失败，请确认后端已启动', icon: 'none' });
            this.setData({ isLoading: false });
          }
        });
      }
    });
  },

  // ── 文件 ──
  onChooseFile() {
    wx.chooseMessageFile({
      count: 1, type: 'file',
      success: (res) => {
        const file = res.tempFiles[0];
        const ext = (file.name || '').split('.').pop()?.toLowerCase();
        const fs = wx.getFileSystemManager();
        // PDF 文件：base64 上传，服务端解析
        if (ext === 'pdf') {
          wx.showLoading({ title: '解析PDF中...' });
          fs.readFile({
            filePath: file.path, encoding: 'base64',
            success: (r) => {
              wx.request({
                url: API + '/api/ai/analyze-pdf', method: 'POST',
                data: { fileBase64: r.data, fileName: file.name },
                success: (resp) => {
                  wx.hideLoading();
                  if (resp.data.error) {
                    wx.showToast({ title: resp.data.error, icon: 'none' });
                  } else {
                    this.setData({ fileContent: resp.data.result, fileName: file.name, hasResult: true, resultType: 'file', aiResult: resp.data.result });
                  }
                },
                fail: () => { wx.hideLoading(); wx.showToast({ title: '连接失败', icon: 'none' }); }
              });
            },
            fail: () => { wx.hideLoading(); wx.showToast({ title: 'PDF读取失败', icon: 'none' }); }
          });
          return;
        }
        // 二进制文件不支持
        if (['doc','docx','xls','xlsx','ppt','pptx'].includes(ext)) {
          wx.showModal({
            title: ext.toUpperCase() + ' 文件不支持直接读取',
            content: '请用手机截图后，点「📷 拍照识别」上传图片，或复制文件内容粘贴到输入框。',
            showCancel: false
          });
          return;
        }
        wx.showLoading({ title: '读取文件中...' });
        fs.readFile({
          filePath: file.path, encoding: 'utf8',
          success: (r) => {
            wx.hideLoading();
            if (!r.data || !r.data.trim()) {
              wx.showToast({ title: '文件为空或无法识别内容', icon: 'none' });
              return;
            }
            // 检测是否乱码（二进制被当作文本读取）
            const sample = r.data.slice(0, 200);
            const garbled = (sample.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
            if (garbled > sample.length * 0.1) {
              wx.showModal({
                title: '文件格式不支持',
                content: '检测到该文件可能是二进制格式，无法直接读取。请用手机截图后点「📷 拍照识别」，或复制内容粘贴到输入框。',
                showCancel: false
              });
              return;
            }
            this.setData({ fileContent: r.data, fileName: file.name, hasResult: false });
          },
          fail: (err) => {
            wx.hideLoading();
            wx.showModal({
              title: '文件读取失败',
              content: '请尝试复制内容粘贴到输入框。错误：' + (err.errMsg || '未知'),
              showCancel: false
            });
          }
        });
      },
      fail: () => {
        // 用户取消选择，不做任何操作
      }
    });
  },

  onAnalyzeFile() {
    this.setData({ isLoading: true, loadingText: '保险专家正在分析文件...', hasResult: false });
    wx.request({
      url: API + '/api/ai/analyze-file', method: 'POST',
      data: { textContent: this.data.fileContent },
      success: (resp) => {
        this.setData({ isLoading: false });
        if (resp.data.error) {
          wx.showToast({ title: resp.data.error, icon: 'none' });
        } else {
          this.setData({
            hasResult: true, resultType: 'file', aiResult: resp.data.result,
            fileContent: '', fileName: '',
          });
        }
      },
      fail: () => {
        wx.showToast({ title: '连接失败，请确认后端已启动', icon: 'none' });
        this.setData({ isLoading: false });
      }
    });
  },

  // ── 翻译（词典 + AI 静默补充） ──
  onTranslate() {
    const text = (this.data.inputText || '').trim();
    if (!text) return;

    // 第一步：词典即时匹配
    const dictResult = translateClause(text);
    this.setData({
      isLoading: false, hasResult: true, resultType: 'text',
      changes: dictResult.changes,
      stats: { termCount: dictResult.termCount, beforeLevel: dictResult.readability.before, afterLevel: dictResult.readability.after },
      isDiscovering: true,
    });

    // 第二步：后台静默调用 AI，结果直接合并到 changes
    wx.request({
      url: API + '/api/ai/discover-terms', method: 'POST', data: { text },
      success: (resp) => {
        if (!resp.data.error && resp.data.discovered) {
          const newTerms = (resp.data.discovered || []).filter(d => {
            return !dictResult.changes.some(c => c.term === d.term);
          });
          if (newTerms.length > 0) {
            const merged = [...dictResult.changes, ...newTerms.map(t => ({ term: t.term, explanation: t.explanation }))];
            const newCount = merged.length;
            let before, after;
            if (newCount === 0) { before = '通俗'; after = '通俗'; }
            else if (newCount <= 2) { before = '较易懂'; after = '大白话'; }
            else if (newCount <= 5) { before = '有点绕'; after = '较易懂'; }
            else if (newCount <= 10) { before = '很难读'; after = '能看懂'; }
            else { before = '天书级别'; after = '能看懂'; }
            this.setData({
              changes: merged,
              stats: { termCount: newCount, beforeLevel: before, afterLevel: after },
              isDiscovering: false,
            });
          } else {
            this.setData({ isDiscovering: false });
          }
        } else {
          this.setData({ isDiscovering: false });
        }
      },
      fail: () => { this.setData({ isDiscovering: false }); }
    });
  },

  // ── 手动询问术语 ──
  onAskInput(e) { this.setData({ askTerm: e.detail.value }); },

  onAskTerm() {
    const term = this.data.askTerm.trim();
    if (!term) return;
    this.setData({ isLoading: true, loadingText: '保险专家正在思考...' });
    wx.request({
      url: API + '/api/ai/explain-term', method: 'POST',
      data: { term, context: this.data.inputText || '' },
      success: (resp) => {
        this.setData({ isLoading: false });
        if (resp.data.error) {
          wx.showToast({ title: resp.data.error, icon: 'none' });
        } else if (resp.data.isRisky) {
          wx.showToast({ title: '该内容涉及风险领域，无法回答', icon: 'none' });
        } else {
          this.setData({ askResult: resp.data });
        }
      },
      fail: () => {
        wx.showToast({ title: '连接失败', icon: 'none' });
        this.setData({ isLoading: false });
      }
    });
  },
});

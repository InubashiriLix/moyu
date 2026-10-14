#include "text.hpp"
#include <stdexcept>
#include <iostream>
#define CHECK(x) do{if(!(x))throw std::runtime_error(#x);}while(0)
int main(){
 try{
    const std::string text="　风吹过山谷。\n他低声说道：“别出声。”\n“你看见了吗？”";
    auto s=nv::segment_text(text);
    CHECK(s.size()==3);CHECK(s[0].emotion=="calm");CHECK(s[1].emotion=="whisper");
    for(const auto& p:s)CHECK(text.substr(p.byte_begin,p.byte_end-p.byte_begin)==p.text);
    CHECK(s[2].text=="“你看见了吗？”");
    std::string longtext;for(int i=0;i<501;++i)longtext+="山";
    s=nv::segment_text(longtext);std::string joined;
    for(const auto&p:s){CHECK(p.text.size()<=360);joined+=p.text;}
    CHECK(joined==longtext);
    CHECK(nv::segment_text("他苦笑着走了。喜鹊飞过窗前。")[0].emotion=="calm");
    nv::TextOptions o;o.instruction_override="温柔地朗读";
    CHECK(nv::segment_text("他愤怒地说：离开！",o)[0].instruction==o.instruction_override);
    o={};o.automatic=false;CHECK(nv::segment_text("他愤怒地说：离开！",o)[0].emotion=="calm");
    o={};o.preceding_context="他低声说";s=nv::segment_text("“等一等。”",o);
    CHECK(s[0].emotion=="whisper");CHECK(s[0].text.find("低声")==std::string::npos);
    CHECK(nv::segment_text("  \n　").empty());
    for(auto invalid:{std::string("\xc0\xaf",2),std::string("\xed\xa0\x80",3),std::string("\xf0\x9f",2)}){
        bool rejected=false;try{nv::segment_text(invalid);}catch(const std::invalid_argument&){rejected=true;}CHECK(rejected);
    }
    std::cout<<"text checks passed\n";return 0;
 }catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}
}
